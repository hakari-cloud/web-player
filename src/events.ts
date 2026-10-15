/** Public event surface. The shape stays stable across hls.js upgrades —
 *  internal hls.js events map onto these. Customers should not depend on
 *  hls.js's own event names. */

export interface PlayerLevel {
  /** Pixel height of the rendition (`720`, `480`, …). */
  height: number
  /** Pixel width. */
  width: number
  /** Total bitrate in bits/sec (video + audio combined). */
  bitrate: number
  /** Stable index into the manifest's variant list. Use with `setQuality`
   *  if you'd rather pick a specific level than match by height. */
  index: number
}

export interface ReadyEvent {
  /** Total media duration in seconds, or `null` for live streams (where
   *  the duration is open-ended). */
  duration: number | null
  /** True for live streams (LL-HLS or classic HLS with no `#EXT-X-ENDLIST`),
   *  false for VOD playlists. */
  live: boolean
  /** Available quality renditions parsed from the master playlist. */
  levels: PlayerLevel[]
}

export interface QualityChangeEvent {
  height: number
  bitrate: number
  /** True when ABR (auto-bitrate) is in control. False when a level was
   *  explicitly pinned via `setQuality(<height>)`. */
  auto: boolean
}

/** An audio rendition: the original soundtrack or a dubbed language. */
export interface PlayerAudioTrack {
  /** Index to pass to `setAudioTrack`. */
  id: number
  /** Display name from the manifest (e.g. "Original", "বাংলা"). */
  name: string
  /** BCP-47 / ISO language code, when the manifest gives one. */
  language?: string
  default: boolean
}

export interface AudioTracksEvent {
  tracks: PlayerAudioTrack[]
  /** id of the playing track. */
  current: number
}

/** A subtitle rendition from the manifest (TYPE=SUBTITLES). */
export interface PlayerSubtitleTrack {
  /** Index to pass to `setSubtitleTrack`. */
  id: number
  name: string
  language?: string
  default: boolean
}

export interface SubtitleTracksEvent {
  tracks: PlayerSubtitleTrack[]
  /** id of the showing track, or -1 when subtitles are off. */
  current: number
}

export interface LevelParsedEvent {
  levels: PlayerLevel[]
}

export interface ErrorEvent {
  /** True if playback can't recover. The player will emit no further
   *  state events for this session. False errors are recovered internally
   *  (network retry, media error recovery) and don't stop playback. */
  fatal: boolean
  /** Coarse category — `NETWORK_ERROR`, `MEDIA_ERROR`, `OTHER_ERROR`,
   *  `KEY_SYSTEM_ERROR`, etc. Same names hls.js uses. */
  type: string
  /** Specific reason within the category. */
  details: string
  /** Human-readable message suitable for surfacing in UI. */
  message: string
  /** Edge-side reason if the failure is auth-related (e.g.
   *  `sig:no-token`, `sig:expired`). Populated when the response carried
   *  an `X-Deny-Reason` header. */
  denyReason?: string
}

export interface LiveSyncEvent {
  /** True when the player is within `liveLatency.max` of the live edge.
   *  Flips to false on user seek-back or buffer drift; back to true once
   *  hls.js (or a `goLive()` call) catches up. UI uses this to switch the
   *  "Live" indicator between active and "Go live" affordances. */
  atEdge: boolean
  /** Current latency in seconds (live-edge minus current playback time).
   *  Always ≥ 0. NaN if the player can't compute it yet (no live edge
   *  reported). */
  latency: number
}

/** Map of event name → payload type. Used to give `on()` autocomplete on
 *  both the event name and the payload it receives. */
export interface PlayerEventMap {
  ready: ReadyEvent
  playing: void
  pause: void
  ended: void
  error: ErrorEvent
  qualitychange: QualityChangeEvent
  levelparsed: LevelParsedEvent
  livesync: LiveSyncEvent
  audiotracks: AudioTracksEvent
  subtitletracks: SubtitleTracksEvent
}

export type PlayerEventName = keyof PlayerEventMap
export type PlayerEventListener<K extends PlayerEventName> = (data: PlayerEventMap[K]) => void
