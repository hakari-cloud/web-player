# @hakari/player

Embed-friendly HLS / LL-HLS player for [Hakari](https://hakari.cloud) live streams and VODs.

Wraps `hls.js` with sensible defaults for Hakari's signed-playback flow:
- `withCredentials: true` by default so the `hakariPlayback` cookie carries across child requests.
- LL-HLS on by default (`#EXT-X-PART` + blocking reload). Auto-falls-back to classic HLS for static VOD playlists.
- Native HLS path on Safari / iOS uses `crossOrigin="use-credentials"` so the cookie attaches there too.
- Errors expose `X-Deny-Reason` from the edge so you can show a useful message ("session expired", "wrong stream", …).

> **Event emission is local only.** The player fires events to listeners you register via `.on()`. Nothing is sent to a server. Telemetry / analytics is a future addition behind an explicit opt-in.

## Install

```sh
npm i @hakari/player
```

## Usage

```ts
import { HakariPlayer } from '@hakari/player'

const video = document.getElementById('player') as HTMLVideoElement
const player = new HakariPlayer(video, {
  // Signed playback URL. Mint it server-side via
  // POST /v1/projects/<slug>/streams/<id>/playback-ticket
  src: 'https://stream.hakari.cloud/<orgSlug>/<streamKey>/llhls.m3u8?token=eyJ...',
})

player.on('ready', (e) => {
  console.log('live?', e.live, 'levels', e.levels)
})
player.on('error', (e) => {
  if (e.denyReason === 'sig:expired') refreshTokenAndReload()
  else console.error(e)
})

player.play()
```

## Embed (no bundler, no importmap)

Drop a single script tag — `hls.js` is inlined, `HakariPlayer` is exposed
on `window`. ~160 KB gzipped.

```html
<video id="v" controls playsinline></video>
<script src="https://unpkg.com/@hakari/player/dist/hakari-player.standalone.global.js"></script>
<script>
  new HakariPlayer(document.getElementById('v'), {
    src: 'https://stream.hakari.cloud/<orgSlug>/<streamKey>/llhls.m3u8?token=...',
    autoplay: true,
    muted: true,
  })
</script>
```

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `src` | `string` | required | Already-signed playback URL. The player doesn't fetch tickets. |
| `autoplay` | `boolean` | `false` | Pair with `muted: true` — browsers block autoplay with audio. |
| `muted` | `boolean` | `false` | |
| `lowLatency` | `boolean` | `true` | LL-HLS partial-segment playback. Safe for VOD too. |
| `withCredentials` | `boolean` | `true` | Send cookies on every media request. Required for signed-playback. |
| `debug` | `boolean` | `false` | Verbose hls.js logging to console. |
| `hlsConfig` | `Partial<HlsConfig>` | `{}` | Escape hatch — merged on top of player defaults. |

## Events

```ts
player.on(event, handler) // returns an unsubscribe function
player.off(event, handler)
```

| Event | Payload | When |
|---|---|---|
| `ready` | `{ duration, live, levels }` | Manifest parsed, decoder ready. |
| `playing` | — | Playback running. |
| `pause` | — | Playback paused. |
| `ended` | — | Reached end of media (VOD). |
| `levelparsed` | `{ levels }` | Variant ladder parsed. |
| `qualitychange` | `{ height, bitrate, auto }` | ABR switched, or `setQuality` applied. |
| `error` | `{ fatal, type, details, message, denyReason? }` | Non-fatal errors are auto-recovered; only fatals fire. |

## API

```ts
player.play(): Promise<void>
player.pause(): void
player.setQuality(height: number | 'auto'): void
player.levels: PlayerLevel[]   // current variants
player.autoQuality: boolean
player.destroy(): void          // tear down hls.js, drop listeners
```

## React

```tsx
import { HakariVideo, ScrubThumbnail, type HakariVideoHandle } from '@hakari/player/react'

function StreamPage({ signedUrl, thumbnailsVtt }) {
  const ref = useRef<HakariVideoHandle>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)

  return (
    <>
      <HakariVideo
        ref={ref}
        src={signedUrl}
        thumbnailVtt={thumbnailsVtt}
        controls
        autoPlay
        muted
        onReady={(e) => console.log('live?', e.live)}
        onError={(e) => alert(e.message)}
      />

      {/* In your custom seekbar's mouse-hover handler:
            setHoverTime(timeAtCursor)
          Then render the preview tooltip: */}
      {hoverTime != null && (
        <ScrubThumbnail player={ref} time={hoverTime} />
      )}
    </>
  )
}
```

`react` and `react-dom` are declared as **optional peer dependencies**.
The vanilla `@hakari/player` import has zero React payload — only
customers who `import` from `@hakari/player/react` pay for the wrapper.

## Browser support

- Chrome / Edge / Firefox: hls.js (MSE).
- Safari (macOS / iOS): native HLS via `<video src=…>`.

## Development

```sh
git clone git@github.com:PiratedKukreja/hakari-player.git
cd hakari-player
npm install
npm run example   # vite dev server with examples/index.html
npm run build     # produces dist/{esm,cjs,d.ts}
```

## License

MIT
