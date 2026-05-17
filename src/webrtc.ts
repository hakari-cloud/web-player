/**
 * Hakari WebRTC playback engine.
 *
 * Talks the OvenMediaEngine WebRTC signalling protocol over WebSocket:
 *
 *   ── handshake ──────────────────────────────────────────────────
 *   client → server : { command: "request_offer" }
 *   server → client : {
 *       command: "offer",
 *       id: <number>,           // session id, echo back on every msg
 *       peer_id: <number>,
 *       sdp: <RTCSessionDescription>,
 *       candidates: <RTCIceCandidateInit[]>,   // trickle: may be empty
 *       ice_servers: <{ urls, username?, credential? }[]>
 *   }
 *   client → server : { command: "answer", id, peer_id, sdp }
 *   client ⇄ server : { command: "candidate", id, peer_id, candidates }
 *
 * Sub-second latency over a single peer connection — no LL-HLS buffering,
 * no playlists. Suitable for the demo-page low-latency engine path.
 *
 * Auth: when the URL carries CloudFront-style `?Policy=…&Signature=…&Key-Pair-Id=…`,
 * those are passed through as WebSocket query params; the edge router accepts
 * the same triple for WS upgrade as it does for HTTP playlists.
 */

import type { ErrorEvent, PlayerEventListener, PlayerEventName, PlayerEventMap } from './events'

export interface HakariWebRTCOptions {
  /** OME WebRTC playback URL.
   *
   *  Accepted shapes:
   *    `wss://stream.hakari.cloud/<orgSlug>/<streamKey>`
   *    `https://stream.hakari.cloud/<orgSlug>/<streamKey>` — auto-upgrades to wss
   *    `<orgSlug>/<streamKey>` (relative) — resolved against window.location
   *
   *  Auth: query string is preserved on the WS upgrade so signed-playback
   *  triples ride through. */
  src: string

  /** Start playback as soon as the peer connection is set up. Browsers
   *  block autoplay-with-sound — pair with `muted: true`. */
  autoplay?: boolean

  /** Mute on start. */
  muted?: boolean

  /** Force a specific transport. Defaults to OME's default (UDP).
   *  Set to 'tcp' for networks that block UDP. */
  transport?: 'udp' | 'tcp'

  /** Verbose console logging during the SDP/ICE handshake. */
  debug?: boolean
}

interface OmeOfferMessage {
  command: 'offer'
  id: number
  peer_id: number
  sdp: RTCSessionDescriptionInit
  candidates?: RTCIceCandidateInit[]
  ice_servers?: Array<{ urls: string | string[]; username?: string; credential?: string }>
  error?: string
}

interface OmeCandidateMessage {
  command: 'candidate'
  id: number
  peer_id: number
  candidates: RTCIceCandidateInit[]
}

interface OmeErrorMessage {
  command: 'error'
  code?: number
  error?: string
}

type OmeMessage = OmeOfferMessage | OmeCandidateMessage | OmeErrorMessage

/** Vanilla WebRTC engine. Mirror-of-API with `HakariPlayer` where it
 *  makes sense (on/off/play/pause/destroy/live), but only emits the
 *  subset of events that apply to a single-peer playback session. */
export class HakariWebRTCPlayer {
  private readonly video: HTMLVideoElement
  private readonly opts: HakariWebRTCOptions
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private destroyed = false
  private sessionId = 0
  private peerId = 0
  private readonly listeners: {
    [K in PlayerEventName]?: Set<PlayerEventListener<K>>
  } = {}

  constructor(video: HTMLVideoElement, opts: HakariWebRTCOptions) {
    if (!video || !(video instanceof HTMLVideoElement)) {
      throw new Error('HakariWebRTCPlayer: first argument must be an HTMLVideoElement')
    }
    if (!opts || typeof opts.src !== 'string' || opts.src.length === 0) {
      throw new Error('HakariWebRTCPlayer: options.src is required')
    }

    this.video = video
    this.opts = opts

    if (opts.muted) this.video.muted = true
    if (opts.autoplay) this.video.autoplay = true
    // WebRTC playback uses srcObject (a MediaStream) — playsinline keeps
    // the video tag inline rather than fullscreen-modal on iOS.
    this.video.playsInline = true
    this.video.setAttribute('playsinline', '')

    this.connect()
  }

  // ── public API ─────────────────────────────────────────────────

  play(): Promise<void> {
    return this.video.play()
  }

  pause(): void {
    this.video.pause()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    if (this.pc) {
      try { this.pc.close() } catch { /* ignore */ }
      this.pc = null
    }
    try { this.video.srcObject = null } catch { /* ignore */ }
    for (const k of Object.keys(this.listeners)) {
      delete (this.listeners as Record<string, unknown>)[k]
    }
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

  /** WebRTC is always live by definition — no playlist, no DVR. */
  get live(): boolean { return true }

  // ── internal ───────────────────────────────────────────────────

  private connect(): void {
    const wsUrl = this.buildWsUrl(this.opts.src)
    this.dbg('connecting to', wsUrl)

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      this.emitFatal('NETWORK_ERROR', 'ws-open-failed', (e as Error).message)
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.dbg('ws open, requesting offer')
      ws.send(JSON.stringify({ command: 'request_offer' }))
    }

    ws.onerror = (e) => {
      this.dbg('ws error', e)
      this.emitFatal('NETWORK_ERROR', 'ws-error', 'WebSocket failed')
    }

    ws.onclose = () => {
      this.dbg('ws closed')
    }

    ws.onmessage = (event) => {
      let msg: OmeMessage
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      this.dbg('ws msg', msg.command)
      if (msg.command === 'offer') {
        this.handleOffer(msg).catch((err) => {
          this.emitFatal('OTHER_ERROR', 'sdp-failed', (err as Error).message)
        })
      } else if (msg.command === 'candidate') {
        this.handleCandidate(msg).catch(() => { /* non-fatal */ })
      } else if (msg.command === 'error') {
        this.emitFatal('NETWORK_ERROR', 'server-error', msg.error || `code ${msg.code}`)
      }
    }
  }

  private async handleOffer(msg: OmeOfferMessage): Promise<void> {
    if (msg.error) {
      this.emitFatal('NETWORK_ERROR', 'offer-error', msg.error)
      return
    }
    this.sessionId = msg.id
    this.peerId = msg.peer_id

    const pcConfig: RTCConfiguration = {}
    if (msg.ice_servers && msg.ice_servers.length > 0) {
      pcConfig.iceServers = msg.ice_servers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      }))
    }
    if (this.opts.transport === 'tcp') {
      // No standard RTCConfiguration flag for "TCP only"; the URL/?transport=tcp
      // hint is handled server-side by OME, which only returns TCP candidates.
    }
    const pc = new RTCPeerConnection(pcConfig)
    this.pc = pc

    pc.ontrack = (e) => {
      this.dbg('ontrack', e.track.kind)
      // The first track delivers the MediaStream — subsequent tracks are
      // added to the same stream by the browser, so we only set srcObject
      // once.
      if (!this.video.srcObject) {
        this.video.srcObject = e.streams[0] ?? new MediaStream([e.track])
      }
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate || !this.ws) return
      this.ws.send(JSON.stringify({
        command: 'candidate',
        id: this.sessionId,
        peer_id: this.peerId,
        candidates: [e.candidate.toJSON()],
      }))
    }

    pc.oniceconnectionstatechange = () => {
      this.dbg('ice state →', pc.iceConnectionState)
      if (pc.iceConnectionState === 'failed') {
        this.emitFatal('NETWORK_ERROR', 'ice-failed', 'ICE negotiation failed')
      }
    }

    await pc.setRemoteDescription(msg.sdp)
    if (msg.candidates) {
      for (const c of msg.candidates) {
        try { await pc.addIceCandidate(c) } catch { /* tolerate malformed */ }
      }
    }

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.ws?.send(JSON.stringify({
      command: 'answer',
      id: this.sessionId,
      peer_id: this.peerId,
      sdp: answer,
    }))

    // Once tracks land, browser fires 'playing' which we forward as ready.
    this.video.addEventListener('playing', () => this.emit('playing', undefined as never), { once: true })
    this.video.addEventListener('loadedmetadata', () => {
      this.emit('ready', {
        duration: null, // live, unknown
        live: true,
        levels: [], // WebRTC = one stream, no ladder
      })
    }, { once: true })
  }

  private async handleCandidate(msg: OmeCandidateMessage): Promise<void> {
    if (!this.pc) return
    for (const c of msg.candidates) {
      try { await this.pc.addIceCandidate(c) } catch { /* tolerate */ }
    }
  }

  private buildWsUrl(src: string): string {
    let url: URL
    try {
      url = new URL(src, typeof window !== 'undefined' ? window.location.href : 'https://stream.hakari.cloud')
    } catch {
      throw new Error(`HakariWebRTCPlayer: invalid src "${src}"`)
    }
    // http(s) → ws(s) — OME signals over the same host:port but as a WS upgrade.
    if (url.protocol === 'http:') url.protocol = 'ws:'
    else if (url.protocol === 'https:') url.protocol = 'wss:'
    if (this.opts.transport === 'tcp') {
      url.searchParams.set('transport', 'tcp')
    }
    return url.toString()
  }

  private emitFatal(type: string, details: string, message: string): void {
    const e: ErrorEvent = { fatal: true, type, details, message }
    this.emit('error', e)
  }

  private dbg(...args: unknown[]): void {
    if (this.opts.debug) console.log('[hakari/webrtc]', ...args)
  }

  private emit<K extends PlayerEventName>(event: K, data: PlayerEventMap[K]): void {
    if (this.destroyed) return
    const bucket = this.listeners[event] as Set<PlayerEventListener<K>> | undefined
    if (!bucket || bucket.size === 0) return
    for (const fn of Array.from(bucket)) {
      try { fn(data) } catch (e) {
        console.error('[hakari/webrtc] listener threw', e)
      }
    }
  }
}
