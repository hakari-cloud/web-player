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

  /** Prefer hls.js over the browser's native HLS implementation, even
   *  when both are available. Defaults to true — gives us consistent
   *  quality control / ABR events / EME hooks across Chrome, Firefox,
   *  Edge, AND Safari. Set to false to use native HLS where the browser
   *  reports support (Safari + iOS WebKit) — wins hardware decode and
   *  battery, loses our quality menu (no JS API for variant list).
   *
   *  Note: Chrome desktop reports `'maybe'` for HLS but doesn't really
   *  play it the way Safari does, so flipping this to false on Chrome
   *  silently breaks playback. Don't override unless you know what
   *  browser you're targeting. */
  overrideNative?: boolean

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
    const overrideNative = this.opts.overrideNative !== false

    // Path priority depends on `overrideNative` (default true). When
    // true: prefer hls.js wherever MSE is available, fall back to
    // native only when MSE isn't there. This is what video.js / JW /
    // Mux / Bitmovin all do — fixes Chrome's misleading
    // canPlayType('application/vnd.apple.mpegurl') = 'maybe' (Chrome
    // reports vague HLS support but doesn't actually play it like
    // Safari does). When false: prefer native HLS where supported
    // (Safari hardware decode), fall back to hls.js elsewhere.
    const tryNative = (): boolean => {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = src
        this.bindNativeEvents(/* native: */ true)
        return true
      }
      return false
    }

    if (!overrideNative && tryNative()) return

    if (!Hls.isSupported()) {
      // MSE unavailable — last resort to native (Safari path when
      // overrideNative is on and MSE somehow not supported, or any
      // other browser without MSE).
      if (overrideNative && tryNative()) return
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
    if (this.notFoundTimer) {
      clearTimeout(this.notFoundTimer)
      this.notFoundTimer = null
    }
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
    // Successful parse — reset the retry budgets so a stream that comes
    // up after a 404 (or briefly drops) gets fresh attempts next time.
    this.networkRetries = 0
    this.notFoundRetries = 0
    if (this.notFoundTimer) {
      clearTimeout(this.notFoundTimer)
      this.notFoundTimer = null
    }
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
  // timeout on a part fetch, etc.). We only act on fatals — others get
  // network-retried / media-recovered transparently.
  //
  // Retry policy:
  //   404 from manifest/level fetch  →  back-off retry [5s, 10s, 15s]
  //     The source isn't there yet (live stream hasn't started, VOD
  //     master uploaded after the dashboard first navigated, etc.).
  //     Immediate retry burns the budget and rarely helps.
  //   Other network errors           →  immediate retry, capped at 3
  //     Transient socket failures, DNS blips, etc.
  //
  // Counters reset on successful manifest parse.
  private networkRetries = 0
  private notFoundRetries = 0
  private notFoundTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly NOT_FOUND_BACKOFF_MS = [5000, 10000, 15000]

  private onHlsError = (_evt: unknown, data: ErrorData): void => {
    // Sniff X-Deny-Reason from the response so the next fatal-error
    // payload can carry it. hls.js's typing for `response` doesn't
    // include headers, but the runtime XHR is reachable.
    const denyReason = readDenyReason(data)
    if (denyReason) this.lastDenyReason = denyReason

    if (!data.fatal) return

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      const status = readResponseCode(data)
      if (status === 404 && this.notFoundRetries < HakariPlayer.NOT_FOUND_BACKOFF_MS.length) {
        const delay = HakariPlayer.NOT_FOUND_BACKOFF_MS[this.notFoundRetries] ?? 15000
        this.notFoundRetries += 1
        if (this.notFoundTimer) clearTimeout(this.notFoundTimer)
        this.notFoundTimer = setTimeout(() => {
          this.notFoundTimer = null
          this.hls?.startLoad()
        }, delay)
        return
      }
      if (status !== 404 && this.networkRetries < 3) {
        this.networkRetries += 1
        this.hls?.startLoad()
        return
      }
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

/** Pull HTTP status code off an hls.js error payload. Different error
 *  shapes attach the response differently — manifest loads use
 *  `data.response.code`, fragment loads sometimes use the same, and
 *  network details might also expose the underlying XHR's status. */
function readResponseCode(data: ErrorData): number | undefined {
  const r = (data as { response?: { code?: number } }).response
  if (r && typeof r.code === 'number') return r.code
  const xhr = (data as { networkDetails?: XMLHttpRequest | unknown }).networkDetails
  if (xhr && typeof (xhr as XMLHttpRequest).status === 'number') {
    const s = (xhr as XMLHttpRequest).status
    return s > 0 ? s : undefined
  }
  return undefined
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
