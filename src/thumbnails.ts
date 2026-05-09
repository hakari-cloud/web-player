/** Sprite-thumbnail support.
 *
 *  Hakari's transcoder produces:
 *    - `sprites.jpg` — atlas of frame thumbnails tiled in a grid.
 *    - `thumbnails.vtt` — WebVTT mapping time-ranges to sprite tiles via
 *      the `#xywh=x,y,w,h` URI fragment (the de-facto standard format
 *      used by JW Player, Bitmovin, Mux, etc.).
 *
 *  We attach the VTT to the video as a `<track kind="metadata">` so the
 *  browser parses cues for us. Customers ask for `getThumbnailAt(time)`
 *  and render the cropped sprite in their own scrub UI. */

export interface Thumbnail {
  /** Absolute URL of the sprite atlas image. Already resolved against
   *  the VTT URL — drop it straight into `<img src=…>` or
   *  `background-image: url(…)`. */
  src: string
  /** X / Y offset in pixels of the tile within the atlas. */
  x: number
  y: number
  /** Tile dimensions in pixels. Use these to size your preview window. */
  w: number
  h: number
}

/** Pull the active cue for a given time and parse its `xywh` fragment.
 *  Returns null when:
 *    - no metadata track has loaded yet (called too early)
 *    - no cue covers `time` (e.g. seeking past the end of recorded sprites)
 *    - the cue text isn't in the expected `<file>#xywh=x,y,w,h` shape. */
export function pickThumbnailAt(
  video: HTMLVideoElement,
  vttBaseUrl: string | null,
  time: number,
): Thumbnail | null {
  const track = findMetadataTrack(video)
  if (!track || !track.cues) return null

  // Cues are sorted by startTime — could binary-search, but a track
  // has on the order of 100s of cues for an hour-long video. Linear
  // scan is fine and avoids the sorted-array assumption.
  let cue: TextTrackCue | null = null
  for (let i = 0; i < track.cues.length; i++) {
    const c = track.cues[i]
    if (!c) continue
    if (time >= c.startTime && time < c.endTime) {
      cue = c
      break
    }
  }
  if (!cue) return null

  const text = (cue as VTTCue).text
  if (!text) return null

  return parseCueText(text, vttBaseUrl)
}

/** Find the track we attached for thumbnails. We look for kind=metadata
 *  with a label hint we set, falling back to the first metadata track
 *  if the customer attached their own. */
function findMetadataTrack(video: HTMLVideoElement): TextTrack | null {
  const tracks = video.textTracks
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if (!t) continue
    if (t.kind === 'metadata' && (t.label === HAKARI_THUMB_LABEL || t.label === 'thumbnails')) {
      return t
    }
  }
  // Fallback — first metadata track regardless of label.
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if (t && t.kind === 'metadata') return t
  }
  return null
}

export const HAKARI_THUMB_LABEL = 'hakari-thumbnails'

/** Parse cue text of the form `sprites.jpg#xywh=0,0,160,90`. The image
 *  reference is resolved against `vttBaseUrl` so a cue can use a relative
 *  filename; the customer doesn't have to think about CDN paths. */
function parseCueText(text: string, vttBaseUrl: string | null): Thumbnail | null {
  const trimmed = text.trim()
  // Format: <imageRef>#xywh=<x>,<y>,<w>,<h>
  const hashIdx = trimmed.indexOf('#xywh=')
  if (hashIdx < 0) return null

  const imageRef = trimmed.substring(0, hashIdx)
  const coords = trimmed.substring(hashIdx + '#xywh='.length).split(',').map(Number)
  if (coords.length !== 4 || coords.some((n) => !Number.isFinite(n))) return null

  let src: string
  try {
    src = vttBaseUrl
      ? new URL(imageRef, vttBaseUrl).href
      : imageRef
  } catch {
    src = imageRef
  }

  return { src, x: coords[0]!, y: coords[1]!, w: coords[2]!, h: coords[3]! }
}
