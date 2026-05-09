import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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

/** Imperative handle exposed via `ref`. Mirrors the vanilla
 *  `HakariPlayer` API — anything you'd reach for after construction. */
export interface HakariVideoHandle {
  play: () => Promise<void>
  pause: () => void
  setQuality: (height: number | 'auto') => void
  getThumbnailAt: (time: number) => Thumbnail | null
  /** Escape hatch — the underlying vanilla player. Use sparingly. */
  player: () => HakariPlayer | null
  /** The native `<video>` for callers that want to read currentTime,
   *  attach extra listeners, etc. */
  video: () => HTMLVideoElement | null
}

export interface HakariVideoProps
  // Drop the React-DOM event handlers we redefine with player-specific
  // payload shapes (onError, onPlaying, onPause, onEnded). `src` is
  // managed by the player. `children` would conflict with the built-in
  // <track> the player adds for sprite thumbnails.
  extends Omit<
    VideoHTMLAttributes<HTMLVideoElement>,
    'src' | 'children' | 'onError' | 'onPlaying' | 'onPause' | 'onEnded'
  > {
  /** Already-signed playback URL. The component does NOT fetch tickets. */
  src: string

  /** WebVTT for sprite-thumbnail scrubbing. See `<ScrubThumbnail>`. */
  thumbnailVtt?: string

  /** Forwarded to the player. Defaults are sensible — read the README
   *  before overriding `withCredentials` or `lowLatency`. */
  lowLatency?: boolean
  withCredentials?: boolean
  debug?: boolean
  hlsConfig?: HakariPlayerOptions['hlsConfig']

  // Event callbacks. Stable identity not required — we re-bind on
  // change so customers can use inline arrow functions safely.
  onReady?: (e: ReadyEvent) => void
  onPlaying?: () => void
  onPause?: () => void
  onEnded?: () => void
  onError?: (e: ErrorEvent) => void
  onQualityChange?: (e: QualityChangeEvent) => void
  onLevelParsed?: (e: LevelParsedEvent) => void
}

/** React wrapper around `HakariPlayer`. Drop-in replacement for `<video>`
 *  — extra `<video>` props (controls, autoPlay, muted, className, style,
 *  poster, …) pass straight through. The player attaches/detaches with
 *  the component lifecycle and reattaches on `src` change. */
export const HakariVideo = forwardRef<HakariVideoHandle, HakariVideoProps>(
  function HakariVideo(props, ref) {
    const {
      src,
      thumbnailVtt,
      lowLatency,
      withCredentials,
      debug,
      hlsConfig,
      onReady,
      onPlaying,
      onPause,
      onEnded,
      onError,
      onQualityChange,
      onLevelParsed,
      ...videoProps
    } = props

    const videoRef = useRef<HTMLVideoElement | null>(null)
    const playerRef = useRef<HakariPlayer | null>(null)

    // Stash callbacks in refs so the lifecycle effect (which binds them
    // once on mount/src-change) always reads the latest user-supplied
    // function. Without this, every render would tear down + rebuild
    // the player just to pick up a new callback identity.
    const cbs = useRef({
      onReady,
      onPlaying,
      onPause,
      onEnded,
      onError,
      onQualityChange,
      onLevelParsed,
    })
    cbs.current = {
      onReady,
      onPlaying,
      onPause,
      onEnded,
      onError,
      onQualityChange,
      onLevelParsed,
    }

    useEffect(() => {
      const video = videoRef.current
      if (!video || !src) return

      const player = new HakariPlayer(video, {
        src,
        thumbnailVtt,
        lowLatency,
        withCredentials,
        debug,
        hlsConfig,
      })
      playerRef.current = player

      const offs = [
        player.on('ready', (e) => cbs.current.onReady?.(e)),
        player.on('playing', () => cbs.current.onPlaying?.()),
        player.on('pause', () => cbs.current.onPause?.()),
        player.on('ended', () => cbs.current.onEnded?.()),
        player.on('error', (e) => cbs.current.onError?.(e)),
        player.on('qualitychange', (e) => cbs.current.onQualityChange?.(e)),
        player.on('levelparsed', (e) => cbs.current.onLevelParsed?.(e)),
      ]

      return () => {
        for (const off of offs) off()
        player.destroy()
        playerRef.current = null
      }
      // hlsConfig is intentionally not a dep — we treat it as init-time
      // config, not a reactive prop. Same for the boolean toggles, which
      // would re-init the engine if they ever changed. Only `src` and
      // `thumbnailVtt` re-init.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, thumbnailVtt])

    useImperativeHandle(
      ref,
      (): HakariVideoHandle => ({
        play: () => playerRef.current?.play() ?? Promise.resolve(),
        pause: () => playerRef.current?.pause(),
        setQuality: (h) => playerRef.current?.setQuality(h),
        getThumbnailAt: (t) => playerRef.current?.getThumbnailAt(t) ?? null,
        player: () => playerRef.current,
        video: () => videoRef.current,
      }),
      [],
    )

    return <video ref={videoRef} {...videoProps} />
  },
)

// ──────────────────────────────────────────────────────────────────────
// <ScrubThumbnail /> — render a sprite tile cropped + scaled.
//
// Pair with your custom seekbar's hover handler to show a scrub preview.
// Kept tiny on purpose — full seekbar UI is up to the customer.
// ──────────────────────────────────────────────────────────────────────

export interface ScrubThumbnailProps {
  /** Ref returned by `<HakariVideo />`. Must be an object ref —
   *  `useRef<HakariVideoHandle>(null)` — not a callback ref. */
  player: Ref<HakariVideoHandle>
  /** Time in seconds to render. Typically the hover position on your
   *  custom seekbar, mapped to a media time. */
  time: number
  /** Optional CSS scale factor applied to the rendered tile. The base
   *  output uses native sprite-tile dimensions (Hakari's transcoder
   *  emits 160px-wide tiles by default — that's the natural size).
   *  Pass `2` to render at 2× via CSS transform. */
  scale?: number
  className?: string
  style?: CSSProperties
}

/** Renders the sprite tile covering `time`, cropped via
 *  `background-image` positioning. Returns null while the VTT is still
 *  loading or when the time falls outside the cue range.
 *
 *  By design this renders at the source tile's native pixel size, which
 *  keeps the math trivial (no atlas-dimension probing). For
 *  larger/smaller previews, use `scale={n}` — applied as a CSS
 *  `transform: scale(n)` from the top-left so layout positioning still
 *  works against the natural rect. Wrap in a fixed-size box if you need
 *  a stable hover-tooltip footprint. */
export function ScrubThumbnail({
  player,
  time,
  scale = 1,
  className,
  style,
}: ScrubThumbnailProps): JSX.Element | null {
  const handle = isRefObject(player) ? player.current : null

  // getThumbnailAt is a cheap linear scan; running it on every `time`
  // change is fine. We don't memoize across handles because cue tables
  // can change between renders if `thumbnailVtt` swapped out.
  const [thumb, setThumb] = useState<Thumbnail | null>(null)
  useEffect(() => {
    setThumb(handle?.getThumbnailAt(time) ?? null)
  }, [handle, time])

  const css = useMemo<CSSProperties>(() => {
    if (!thumb) return {}
    return {
      width: thumb.w,
      height: thumb.h,
      backgroundImage: `url(${thumb.src})`,
      backgroundPosition: `-${thumb.x}px -${thumb.y}px`,
      backgroundRepeat: 'no-repeat',
      transform: scale === 1 ? undefined : `scale(${scale})`,
      transformOrigin: 'top left',
    }
  }, [thumb, scale])

  if (!thumb) return null
  return <div className={className} style={{ ...css, ...style }} />
}

function isRefObject<T>(r: Ref<T>): r is { current: T | null } {
  return r != null && typeof r === 'object' && 'current' in (r as object)
}
