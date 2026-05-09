import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as RMouseEvent,
  type Ref,
  type VideoHTMLAttributes,
} from 'react'

import { HakariPlayer, type HakariPlayerOptions } from './player'
import type {
  ErrorEvent,
  LevelParsedEvent,
  PlayerLevel,
  QualityChangeEvent,
  ReadyEvent,
} from './events'
import type { Thumbnail } from './thumbnails'
import { ensureHakariCss } from './ui.css'

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface HakariPlayerHandle {
  play: () => Promise<void>
  pause: () => void
  setQuality: (h: number | 'auto') => void
  toggleFullscreen: () => void
  video: () => HTMLVideoElement | null
  player: () => HakariPlayer | null
}

export interface HakariPlayerControlsToggle {
  /** Bottom-bar play/pause button + center-overlay button. Default true. */
  play?: boolean
  /** Seekbar with thumbnail tooltip. Default true (on live, shows live
   *  indicator instead of a draggable seek). */
  seek?: boolean
  /** Time / duration display. Default true. */
  time?: boolean
  /** Mute toggle. Default true. */
  mute?: boolean
  /** Quality menu. Default true; auto-hides when only one quality exists. */
  quality?: boolean
  /** Fullscreen toggle. Default true. */
  fullscreen?: boolean
}

export interface HakariPlayerProps
  extends Omit<
    VideoHTMLAttributes<HTMLVideoElement>,
    'src' | 'children' | 'controls' | 'onError' | 'onPlaying' | 'onPause' | 'onEnded'
  > {
  src: string
  thumbnailVtt?: string

  lowLatency?: boolean
  withCredentials?: boolean
  debug?: boolean
  hlsConfig?: HakariPlayerOptions['hlsConfig']

  /** CSS color used for accent (seekbar fill, scrub handle, active
   *  menu items). Defaults to Hakari cyan `#3BFFD4`. */
  accentColor?: string

  /** Show / hide individual control elements. Pass `false` to hide all. */
  controls?: boolean | HakariPlayerControlsToggle

  // Player events
  onReady?: (e: ReadyEvent) => void
  onPlaying?: () => void
  onPause?: () => void
  onEnded?: () => void
  onError?: (e: ErrorEvent) => void
  onQualityChange?: (e: QualityChangeEvent) => void
  onLevelParsed?: (e: LevelParsedEvent) => void
}

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_CONTROLS: Required<HakariPlayerControlsToggle> = {
  play: true,
  seek: true,
  time: true,
  mute: true,
  quality: true,
  fullscreen: true,
}

export const HakariPlayerUI = forwardRef<HakariPlayerHandle, HakariPlayerProps>(
  // Inner display name for React DevTools. Don't reuse `HakariPlayer`
  // here — that's the class imported from `./player`, and the same
  // identifier in this scope would shadow it inside the component body.
  function HakariPlayerUIInner(props, ref) {
    const {
      src,
      thumbnailVtt,
      lowLatency,
      withCredentials,
      debug,
      hlsConfig,
      accentColor,
      controls,
      onReady,
      onPlaying,
      onPause,
      onEnded,
      onError,
      onQualityChange,
      onLevelParsed,
      className,
      style,
      ...videoProps
    } = props

    const containerRef = useRef<HTMLDivElement | null>(null)
    const videoRef = useRef<HTMLVideoElement | null>(null)
    const playerRef = useRef<HakariPlayer | null>(null)

    // ── lifecycle ─────────────────────────────────────────────────

    useEffect(() => { ensureHakariCss() }, [])

    // Keep callback identities fresh without re-init.
    const cbs = useRef({ onReady, onPlaying, onPause, onEnded, onError, onQualityChange, onLevelParsed })
    cbs.current = { onReady, onPlaying, onPause, onEnded, onError, onQualityChange, onLevelParsed }

    // Player UI state.
    const [isPlaying, setIsPlaying] = useState(false)
    const [isMuted, setIsMuted] = useState(!!props.muted)
    const [duration, setDuration] = useState(0)
    const [currentTime, setCurrentTime] = useState(0)
    const [bufferedEnd, setBufferedEnd] = useState(0)
    const [isLive, setIsLive] = useState(false)
    const [levels, setLevels] = useState<PlayerLevel[]>([])
    const [activeLevelHeight, setActiveLevelHeight] = useState<number | null>(null)
    const [autoQuality, setAutoQuality] = useState(true)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
    const [idle, setIdle] = useState(false)
    const idleTimer = useRef<number | null>(null)

    useEffect(() => {
      const video = videoRef.current
      if (!video || !src) return

      const player = new HakariPlayer(video, {
        src, thumbnailVtt, lowLatency, withCredentials, debug, hlsConfig,
      })
      playerRef.current = player

      const offs = [
        player.on('ready', (e) => {
          setDuration(e.duration ?? 0)
          setIsLive(e.live)
          setLevels(e.levels)
          cbs.current.onReady?.(e)
        }),
        player.on('levelparsed', (e) => {
          setLevels(e.levels)
          cbs.current.onLevelParsed?.(e)
        }),
        player.on('qualitychange', (e) => {
          setActiveLevelHeight(e.height)
          setAutoQuality(e.auto)
          cbs.current.onQualityChange?.(e)
        }),
        player.on('playing', () => { setIsPlaying(true); cbs.current.onPlaying?.() }),
        player.on('pause', () => { setIsPlaying(false); cbs.current.onPause?.() }),
        player.on('ended', () => { setIsPlaying(false); cbs.current.onEnded?.() }),
        player.on('error', (e) => cbs.current.onError?.(e)),
      ]

      // Native progress events drive the seekbar.
      const onTime = () => setCurrentTime(video.currentTime)
      const onDur = () => Number.isFinite(video.duration) && setDuration(video.duration)
      const onProg = () => {
        const r = video.buffered
        if (r.length > 0) setBufferedEnd(r.end(r.length - 1))
      }
      const onVol = () => setIsMuted(video.muted)
      video.addEventListener('timeupdate', onTime)
      video.addEventListener('durationchange', onDur)
      video.addEventListener('progress', onProg)
      video.addEventListener('volumechange', onVol)

      return () => {
        for (const off of offs) off()
        video.removeEventListener('timeupdate', onTime)
        video.removeEventListener('durationchange', onDur)
        video.removeEventListener('progress', onProg)
        video.removeEventListener('volumechange', onVol)
        player.destroy()
        playerRef.current = null
      }
      // Init-time options. Callbacks read latest via cbs.current.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, thumbnailVtt])

    // Fullscreen API listener — tracks browser-driven fullscreen changes
    // (Esc key, F11) so the icon stays in sync.
    useEffect(() => {
      const handler = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
      document.addEventListener('fullscreenchange', handler)
      return () => document.removeEventListener('fullscreenchange', handler)
    }, [])

    // Auto-hide controls during playback.
    const bumpIdle = useCallback(() => {
      setIdle(false)
      if (idleTimer.current) window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => {
        if (isPlaying) setIdle(true)
      }, 2500)
    }, [isPlaying])

    useEffect(() => {
      // Reset idle state when paused — controls always visible while paused.
      if (!isPlaying) {
        setIdle(false)
        if (idleTimer.current) window.clearTimeout(idleTimer.current)
        return
      }
      bumpIdle()
    }, [isPlaying, bumpIdle])

    // ── imperative API ────────────────────────────────────────────

    const togglePlay = useCallback(() => {
      const v = videoRef.current
      if (!v) return
      if (v.paused || v.ended) { v.play().catch(() => {}) } else { v.pause() }
    }, [])

    const toggleMute = useCallback(() => {
      const v = videoRef.current
      if (!v) return
      v.muted = !v.muted
    }, [])

    const toggleFullscreen = useCallback(() => {
      const el = containerRef.current
      if (!el) return
      if (document.fullscreenElement === el) {
        document.exitFullscreen().catch(() => {})
      } else {
        el.requestFullscreen().catch(() => {})
      }
    }, [])

    useImperativeHandle(ref, (): HakariPlayerHandle => ({
      play: () => playerRef.current?.play() ?? Promise.resolve(),
      pause: () => playerRef.current?.pause(),
      setQuality: (h) => playerRef.current?.setQuality(h),
      toggleFullscreen,
      video: () => videoRef.current,
      player: () => playerRef.current,
    }), [toggleFullscreen])

    // ── derived ───────────────────────────────────────────────────

    const ctrl: Required<HakariPlayerControlsToggle> = useMemo(() => {
      if (controls === false) return { play: false, seek: false, time: false, mute: false, quality: false, fullscreen: false }
      if (controls === true || controls === undefined) return DEFAULT_CONTROLS
      return { ...DEFAULT_CONTROLS, ...controls }
    }, [controls])

    const containerClass = [
      'hakari-player',
      isFullscreen ? 'fullscreen' : '',
      isPlaying ? 'is-playing' : 'paused',
      idle ? 'idle' : '',
      className || '',
    ].filter(Boolean).join(' ')

    const containerStyle: CSSProperties = useMemo(() => ({
      ...(accentColor ? { ['--hakari-accent' as any]: accentColor } : {}),
      ...style,
    }), [accentColor, style])

    return (
      <div
        ref={containerRef}
        className={containerClass}
        style={containerStyle}
        onMouseMove={bumpIdle}
        onMouseLeave={() => isPlaying && setIdle(true)}
        onClick={(e) => {
          // Click on the video area (not on controls) toggles play.
          if (e.target === containerRef.current || (e.target as HTMLElement).tagName === 'VIDEO') {
            togglePlay()
          }
        }}
      >
        <video
          ref={videoRef}
          playsInline
          // We render our own controls, but expose autoPlay/muted/poster
          // pass-through. `controls` is forced off so the browser doesn't
          // double up.
          {...videoProps}
        />

        {/* Center play overlay — visible while paused */}
        {ctrl.play && (
          <div className="hakari-center-play" onClick={togglePlay} role="button" aria-label="Play">
            <PlayIcon size={80} />
          </div>
        )}

        {/* LIVE indicator (top-left) */}
        {isLive && (
          <div style={{ position: 'absolute', top: 12, left: 12 }}>
            <LiveBadge atLiveEdge={isAtLiveEdge(currentTime, bufferedEnd)} onClick={() => seekToLive(videoRef.current, bufferedEnd)} />
          </div>
        )}

        {/* Bottom controls bar */}
        <div className="hakari-controls" onClick={(e) => e.stopPropagation()}>
          {ctrl.seek && !isLive && (
            <Seekbar
              currentTime={currentTime}
              duration={duration}
              bufferedEnd={bufferedEnd}
              onSeek={(t) => { const v = videoRef.current; if (v) v.currentTime = t }}
              getThumbnail={(t) => playerRef.current?.getThumbnailAt(t) ?? null}
            />
          )}

          <div className="hakari-buttons">
            {ctrl.play && (
              <button className="hakari-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
            )}

            {ctrl.mute && (
              <button className="hakari-btn" onClick={toggleMute} aria-label={isMuted ? 'Unmute' : 'Mute'}>
                {isMuted ? <MutedIcon /> : <SoundIcon />}
              </button>
            )}

            {ctrl.time && !isLive && (
              <span className="hakari-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
            )}
            {ctrl.time && isLive && (
              <span className="hakari-time" />
            )}

            <span className="hakari-spacer" />

            {ctrl.quality && levels.length > 0 && (
              <div className="hakari-menu-wrap">
                <button
                  className="hakari-btn hakari-quality-btn"
                  onClick={() => setQualityMenuOpen((v) => !v)}
                  aria-label="Quality"
                  aria-expanded={qualityMenuOpen}
                >
                  {autoQuality
                    ? `Auto${activeLevelHeight ? ` · ${activeLevelHeight}p` : ''}`
                    : `${activeLevelHeight ?? '—'}p`}
                </button>
                {qualityMenuOpen && (
                  <div className="hakari-menu" onMouseLeave={() => setQualityMenuOpen(false)}>
                    <button
                      className={'hakari-menu-item' + (autoQuality ? ' active' : '')}
                      onClick={() => { playerRef.current?.setQuality('auto'); setQualityMenuOpen(false) }}
                    >
                      Auto{autoQuality && activeLevelHeight ? ` (${activeLevelHeight}p)` : ''}
                    </button>
                    {[...levels].sort((a, b) => b.height - a.height).map((l) => (
                      <button
                        key={l.index}
                        className={'hakari-menu-item' + (!autoQuality && l.height === activeLevelHeight ? ' active' : '')}
                        onClick={() => { playerRef.current?.setQuality(l.height); setQualityMenuOpen(false) }}
                      >
                        {l.height}p
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {ctrl.fullscreen && (
              <button className="hakari-btn" onClick={toggleFullscreen} aria-label="Fullscreen">
                {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  },
)

// ──────────────────────────────────────────────────────────────────────
// Seekbar with thumbnail tooltip
// ──────────────────────────────────────────────────────────────────────

interface SeekbarProps {
  currentTime: number
  duration: number
  bufferedEnd: number
  onSeek: (t: number) => void
  getThumbnail: (t: number) => Thumbnail | null
}

function Seekbar({ currentTime, duration, bufferedEnd, onSeek, getThumbnail }: SeekbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  // `width` is the seekbar's pixel width at the moment of hover — used
  // to clamp the tooltip so it never overflows past the seekbar edges.
  const [hover, setHover] = useState<{ x: number; t: number; thumb: Thumbnail | null; width: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  const ratio = duration > 0 ? Math.min(1, currentTime / duration) : 0
  const bufferedRatio = duration > 0 ? Math.min(1, bufferedEnd / duration) : 0

  const fromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el || duration <= 0) return null
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    const t = (x / rect.width) * duration
    return { x, t, width: rect.width }
  }

  const onMove = (e: RMouseEvent<HTMLDivElement>) => {
    const p = fromClientX(e.clientX)
    if (!p) { setHover(null); return }
    setHover({ x: p.x, t: p.t, thumb: getThumbnail(p.t), width: p.width })
    if (scrubbing) onSeek(p.t)
  }
  const onLeave = () => { if (!scrubbing) setHover(null) }
  const onDown = (e: RMouseEvent<HTMLDivElement>) => {
    const p = fromClientX(e.clientX)
    if (!p) return
    setScrubbing(true)
    onSeek(p.t)
  }

  // Window-level mouse-up so dragging off the seekbar still releases.
  useEffect(() => {
    if (!scrubbing) return
    const up = () => setScrubbing(false)
    const move = (ev: globalThis.MouseEvent) => {
      const p = fromClientX(ev.clientX)
      if (!p) return
      setHover({ x: p.x, t: p.t, thumb: getThumbnail(p.t), width: p.width })
      onSeek(p.t)
    }
    window.addEventListener('mouseup', up)
    window.addEventListener('mousemove', move)
    return () => {
      window.removeEventListener('mouseup', up)
      window.removeEventListener('mousemove', move)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing])

  // The tooltip is positioned with `transform: translateX(-50%)` so it
  // visually centers on `tooltipX`. Clamp so the centered tooltip stays
  // inside [0, seekbarWidth]. Width approximated from the sprite tile
  // (4px container padding on each side per the .hakari-scrub-tooltip
  // CSS). Falls back to the time-only label width when no thumb yet.
  const tooltipPx = hover
    ? (() => {
        const tooltipW = (hover.thumb?.w ?? 80) + 8
        const half = tooltipW / 2
        const minX = half
        const maxX = hover.width - half
        // If seekbar is narrower than the tooltip, just center the
        // tooltip on the seekbar — fallback for absurdly thin players.
        if (maxX < minX) return hover.width / 2
        return Math.max(minX, Math.min(maxX, hover.x))
      })()
    : 0

  return (
    <div
      className={'hakari-seekbar' + (scrubbing ? ' scrubbing' : '')}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onMouseDown={onDown}
    >
      {hover && (
        <div className="hakari-scrub-tooltip" style={{ left: `${tooltipPx}px` }}>
          {hover.thumb ? (
            <div
              style={{
                width: hover.thumb.w,
                height: hover.thumb.h,
                backgroundImage: `url(${hover.thumb.src})`,
                backgroundPosition: `-${hover.thumb.x}px -${hover.thumb.y}px`,
                backgroundRepeat: 'no-repeat',
                borderRadius: 3,
              }}
            />
          ) : null}
          <div className="hakari-scrub-tooltip-time">{formatTime(hover.t)}</div>
        </div>
      )}
      <div ref={trackRef} className="hakari-seekbar-track">
        <div className="hakari-seekbar-buffered" style={{ width: `${bufferedRatio * 100}%` }} />
        <div className="hakari-seekbar-played" style={{ width: `${ratio * 100}%` }} />
        <div className="hakari-seekbar-handle" style={{ left: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Live badge
// ──────────────────────────────────────────────────────────────────────

function LiveBadge({ atLiveEdge, onClick }: { atLiveEdge: boolean; onClick: () => void }) {
  return (
    <div
      className={'hakari-live ' + (atLiveEdge ? 'is-live' : 'behind')}
      onClick={atLiveEdge ? undefined : onClick}
      title={atLiveEdge ? 'Live' : 'Behind live — click to jump to live'}
    >
      <span className="hakari-live-dot" />
      <span>{atLiveEdge ? 'Live' : 'Go live'}</span>
    </div>
  )
}

function isAtLiveEdge(currentTime: number, bufferedEnd: number): boolean {
  if (bufferedEnd <= 0) return true
  return bufferedEnd - currentTime < 8 // within 8s of buffer end = at edge
}

function seekToLive(video: HTMLVideoElement | null, bufferedEnd: number) {
  if (!video || bufferedEnd <= 0) return
  // Step a hair before the absolute edge so we don't immediately stall
  // waiting for a brand-new segment.
  video.currentTime = Math.max(0, bufferedEnd - 1)
  video.play().catch(() => {})
}

// ──────────────────────────────────────────────────────────────────────
// Helpers + icons (inline SVG, no font dep)
// ──────────────────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function PlayIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
}
function PauseIcon() { return <svg width="20" height="20" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg> }
function SoundIcon() { return <svg width="20" height="20" viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg> }
function MutedIcon() { return <svg width="20" height="20" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg> }
function FullscreenIcon() { return <svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg> }
function ExitFullscreenIcon() { return <svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg> }
