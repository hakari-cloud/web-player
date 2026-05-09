import Hls, { type ErrorData, type ManifestParsedData, type LevelSwitchedData } from 'hls.js'
import type {
  ErrorEvent,
  PlayerEventListener,
  PlayerEventMap,
  PlayerEventName,
  PlayerLevel,
} from './events'
import { HAKARI_THUMB_LABEL, pickThumbnailAt, type Thumbnail } from './thumbnails'

export interface HakariPlayerOptions {
  /** Playback URL. Already-signed (token in query string) — the player
   *  doesn't fetch tickets on your behalf. After the first hit lands and
   *  the edge sets the `hakariPlayback` cookie, child requests inherit
   *  auth automatically as long as `withCredentials` is on. */
  src: string

  /** Start playback as soon as the manifest parses. Defaults to false.
   *  Browsers block autoplay with sound — pair with `muted: true`. */
  autoplay?: boolean

  /** Mute on start. Defaults to false. */
  muted?: boolean

  /** Enable LL-HLS partial-segment playback (`#EXT-X-PART`, blocking
   *  reload). Defaults to true. Safe to leave on for static VOD too —
   *  hls.js auto-falls-back when the playlist has no parts. */
  lowLatency?: boolean

  /** Send cookies on every media request. Required for Hakari's signed-
   *  playback cookie flow (the master URL has a token, the edge sets a
   *  scoped cookie, child requests must carry it back). Defaults to true.
   *  Set to false only if you're playing fully public content from a
   *  server that rejects credentialed CORS. */
  withCredentials?: boolean

  /** Verbose hls.js logging to console. Useful while integrating. */
  debug?: boolean

  /** Optional WebVTT URL for sprite-based scrub thumbnails. Hakari's
   *  transcoder writes this as `thumbnails.vtt` next to the master
   *  playlist; pass it here and the player attaches a hidden metadata
   *  track. Use `getThumbnailAt(time)` to look up a tile. */
  thumbnailVtt?: string

  /** Override the underlying hls.js config. Merged on top of the player's
   *  defaults — escape hatch only, prefer dedicated options above. */
  hlsConfig?: Partial<ConstructorParameters<typeof Hls>[0]>
}

export class HakariPlayer {
  private readonly video: HTMLVideoElement
  private readonly opts: HakariPlayerOptions
  private hls: Hls | null = null
  private destroyed = false
  private readonly listeners: {
    [K in PlayerEventName]?: Set<PlayerEventListener<K>>
  } = {}

  /** Last `X-Deny-Reason` header seen on a failing media response. Stashed
   *  so the next emitted error event can include it without forcing the
   *  caller to dig through hls.js internals. */
  private lastDenyReason: string | undefined

  constructor(video: HTMLVideoElement, opts: HakariPlayerOptions) {
    if (!video || !(video instanceof HTMLVideoElement)) {
      throw new Error('HakariPlayer: first argument must be an HTMLVideoElement')
    }
    if (!opts || typeof opts.src !== 'string' || opts.src.length === 0) {
      throw new Error('HakariPlayer: options.src is required')
    }

    this.video = video
    this.opts = opts

    const withCreds = opts.withCredentials !== false
    if (withCreds) {
      // Required for the Safari native-HLS path (otherwise it fetches
      // segments without cookies even when the page is credentialed).
      this.video.crossOrigin = 'use-credentials'
    }
    if (opts.muted) this.video.muted = true
    if (opts.autoplay) this.video.autoplay = true

    this.attachThumbnailTrack()
    this.attach()
  }

  /** Inject a hidden metadata `<track>` for the sprite-thumbnail VTT.
   *  The browser parses cues for us; `getThumbnailAt` reads from there.
   *  No-op when `thumbnailVtt` isn't set. */
  private attachThumbnailTrack(): void {
    const url = this.opts.thumbnailVtt
    if (!url) return
    // Avoid duplicate tracks if a caller re-uses the same video element.
    for (let i = 0; i < this.video.querySelectorAll('track').length; i++) {
      const t = this.video.querySelectorAll('track')[i] as HTMLTrackElement | undefined
      if (t && t.label === HAKARI_THUMB_LABEL) return
    }
    const track = document.createElement('track')
    track.kind = 'metadata'
    track.label = HAKARI_THUMB_LABEL
    track.src = url
    track.default = true
    this.video.appendChild(track)
  }

  // ── lifecycle ──────────────────────────────────────────────────

  private attach(): void {
    const { src } = this.opts
    const withCreds = this.opts.withCredentials !== false

    // Native HLS — Safari, iOS WebView. Hardware decode + battery win.
    // No EME / DRM hooks on this path; that's a tomorrow problem.
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = src
      this.bindNativeEvents(/* native: */ true)
      return
    }

    if (!Hls.isSupported()) {
      this.emit('error', {
        fatal: true,
        type: 'INIT_ERROR',
        details: 'mse-unsupported',
        message: 'Media Source Extensions are not available in this browser',
      })
      return
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: this.opts.lowLatency !== false,
      debug: !!this.opts.debug,
      ...(withCreds
        ? { xhrSetup: (xhr) => { xhr.withCredentials = true } }
        : {}),
      ...(this.opts.hlsConfig || {}),
    })
    this.hls = hls

    hls.on(Hls.Events.MANIFEST_PARSED, this.onManifestParsed)
    hls.on(Hls.Events.LEVEL_SWITCHED, this.onLevelSwitched)
    hls.on(Hls.Events.ERROR, this.onHlsError)

    hls.loadSource(src)
    hls.attachMedia(this.video)
    this.bindNativeEvents(/* native: */ false)
  }

  private bindNativeEvents(_native: boolean): void {
    const fwd = (name: 'playing' | 'pause' | 'ended') => () => this.emit(name, undefined as never)
    this.video.addEventListener('playing', fwd('playing'))
    this.video.addEventListener('pause', fwd('pause'))
    this.video.addEventListener('ended', fwd('ended'))
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.hls) {
      try { this.hls.destroy() } catch { /* ignore */ }
      this.hls = null
    }
    // Don't touch video element — caller owns it. Strip src so the
    // browser stops any in-flight fetches.
    try { this.video.removeAttribute('src'); this.video.load() } catch { /* ignore */ }
    // Drop listener sets so accidental late emits don't fire.
    for (const k of Object.keys(this.listeners)) {
      delete (this.listeners as Record<string, unknown>)[k]
    }
  }

  // ── public API ─────────────────────────────────────────────────

  play(): Promise<void> {
    return this.video.play()
  }

  pause(): void {
    this.video.pause()
  }

  /** Switch quality. `'auto'` re-enables ABR; a number pins to the level
   *  with that height (no-op if no level matches). */
  setQuality(height: number | 'auto'): void {
    if (!this.hls) return
    if (height === 'auto') {
      this.hls.currentLevel = -1
      return
    }
    const idx = this.hls.levels.findIndex((l) => l.height === height)
    if (idx >= 0) this.hls.currentLevel = idx
  }

  /** Available levels (matches the most recent `levelparsed` payload). */
  get levels(): PlayerLevel[] {
    return this.hls ? toPublicLevels(this.hls.levels) : []
  }

  /** Sprite tile covering `time` (seconds). Returns null when:
   *    - no `thumbnailVtt` was configured
   *    - the VTT hasn't finished loading
   *    - `time` falls outside the cue range (e.g. live edge of a stream
   *      whose recorder hasn't written that frame yet).
   *  Render with an `<img src={t.src}>` clipped to `(t.x, t.y, t.w, t.h)`,
   *  or as a `background-image` with `background-position: -t.x -t.y`. */
  getThumbnailAt(time: number): Thumbnail | null {
    const vttUrl = this.opts.thumbnailVtt || null
    return pickThumbnailAt(this.video, vttUrl, time)
  }

  /** True when ABR is in control, false when a level is pinned. */
  get autoQuality(): boolean {
    return this.hls ? this.hls.autoLevelEnabled : true
  }

  on<K extends PlayerEventName>(event: K, listener: PlayerEventListener<K>): () => void {
    let bucket = this.listeners[event] as Set<PlayerEventListener<K>> | undefined
    if (!bucket) {
      bucket = new Set()
      this.listeners[event] = bucket as never
    }
    bucket.add(listener)
    return () => { bucket!.delete(listener) }
  }

  off<K extends PlayerEventName>(event: K, listener: PlayerEventListener<K>): void {
    (this.listeners[event] as Set<PlayerEventListener<K>> | undefined)?.delete(listener)
  }

  // ── internal: hls.js bridge ────────────────────────────────────

  private onManifestParsed = (_evt: unknown, data: ManifestParsedData): void => {
    const levels = toPublicLevels(data.levels)
    this.emit('levelparsed', { levels })
    this.emit('ready', {
      duration: Number.isFinite(this.video.duration) && this.video.duration > 0
        ? this.video.duration
        : null,
      live: !!(data as ManifestParsedData & { live?: boolean }).live,
      levels,
    })
  }

  private onLevelSwitched = (_evt: unknown, data: LevelSwitchedData): void => {
    if (!this.hls) return
    const level = this.hls.levels[data.level]
    if (!level) return
    this.emit('qualitychange', {
      height: level.height,
      bitrate: level.bitrate,
      auto: this.hls.autoLevelEnabled,
    })
  }

  // hls.js fires non-fatal errors constantly (404 on a single segment,
  // timeout on a part fetch, etc.). We only emit on fatals — others get
  // network-retried / media-recovered transparently.
  private networkRetries = 0
  private onHlsError = (_evt: unknown, data: ErrorData): void => {
    // Sniff X-Deny-Reason from the response so the next fatal-error
    // payload can carry it. hls.js's typing for `response` doesn't
    // include headers, but the runtime XHR is reachable.
    const denyReason = readDenyReason(data)
    if (denyReason) this.lastDenyReason = denyReason

    if (!data.fatal) return

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.networkRetries < 3) {
      this.networkRetries += 1
      this.hls?.startLoad()
      return
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try { this.hls?.recoverMediaError() } catch { /* fall through */ }
      return
    }

    const out: ErrorEvent = {
      fatal: true,
      type: data.type,
      details: data.details,
      message: data.error?.message || data.details,
    }
    if (this.lastDenyReason) out.denyReason = this.lastDenyReason
    this.emit('error', out)
  }

  // ── emit ──────────────────────────────────────────────────────

  private emit<K extends PlayerEventName>(event: K, data: PlayerEventMap[K]): void {
    if (this.destroyed) return
    const bucket = this.listeners[event] as Set<PlayerEventListener<K>> | undefined
    if (!bucket || bucket.size === 0) return
    // Snapshot before iterating — listeners may unsubscribe themselves.
    for (const fn of Array.from(bucket)) {
      try { fn(data) } catch (e) {
        // Don't let one bad listener kill the rest. Surface via console
        // so customer apps can debug their own handlers.
        console.error('[hakari/player] listener threw', e)
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────

interface HlsRuntimeLevel {
  height: number
  width: number
  bitrate: number
}

function toPublicLevels(hlsLevels: readonly HlsRuntimeLevel[]): PlayerLevel[] {
  return hlsLevels.map((l, i) => ({
    height: l.height,
    width: l.width,
    bitrate: l.bitrate,
    index: i,
  }))
}

/** Best-effort: pull `X-Deny-Reason` off the failing response if hls.js
 *  surfaced it. Different error shapes hold the response in different
 *  places (manifest vs fragment loads). Return undefined if not found. */
function readDenyReason(data: ErrorData): string | undefined {
  // Fragment / playlist loaders attach the underlying XHR via networkDetails.
  const xhr = (data as { networkDetails?: XMLHttpRequest | unknown }).networkDetails
  if (xhr && typeof (xhr as XMLHttpRequest).getResponseHeader === 'function') {
    const v = (xhr as XMLHttpRequest).getResponseHeader('X-Deny-Reason')
    if (v) return v
  }
  // Some hls.js versions stash response headers on `data.response`.
  const response = (data as { response?: { headers?: Record<string, string> } }).response
  const v = response?.headers?.['x-deny-reason'] || response?.headers?.['X-Deny-Reason']
  return v || undefined
}
