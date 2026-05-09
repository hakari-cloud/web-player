# @hakari/web-player

Embed-friendly HLS / LL-HLS player for [Hakari](https://hakari.cloud) live streams and VODs.

Wraps `hls.js` with sensible defaults for Hakari's signed-playback flow:
- `withCredentials: true` by default so the `hakariPlayback` cookie carries across child requests.
- LL-HLS on by default (`#EXT-X-PART` + blocking reload). Auto-falls-back to classic HLS for static VOD playlists.
- Native HLS path on Safari / iOS uses `crossOrigin="use-credentials"` so the cookie attaches there too.
- Errors expose `X-Deny-Reason` from the edge so you can show a useful message ("session expired", "wrong stream", …).

> **Event emission is local only.** The player fires events to listeners you register via `.on()`. Nothing is sent to a server. Telemetry / analytics is a future addition behind an explicit opt-in.

## Install

```sh
npm i @hakari/web-player
```

## Usage

```ts
import { HakariPlayer } from '@hakari/web-player'

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
<script src="https://unpkg.com/@hakari/web-player/dist/web-player.standalone.global.js"></script>
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

The React subexport ships **two** components and one helper:

| Import | Renders | When to use |
|---|---|---|
| `<HakariPlayer>` | Custom controls UI (play/pause, seekbar with scrub thumbnails, time, mute, quality menu, fullscreen, live indicator) | The default. Drop in and you get a full player. |
| `<HakariVideo>` | Bare `<video>` with native browser controls | When you want to build your own UI from scratch. |
| `<ScrubThumbnail>` | A single sprite tile cropped + positioned | Building a custom seekbar with `<HakariVideo>` and want our thumbnail rendering. |

```tsx
import { HakariPlayer, type HakariPlayerHandle } from '@hakari/web-player/react'

function StreamPage({ signedUrl, thumbnailsVtt }) {
  const ref = useRef<HakariPlayerHandle>(null)

  return (
    <HakariPlayer
      ref={ref}
      src={signedUrl}
      thumbnailVtt={thumbnailsVtt}
      autoPlay
      muted
      accentColor="#3BFFD4"
      onReady={(e) => console.log('live?', e.live)}
      onError={(e) => alert(e.message)}
    />
  )
}
```

Imperative API on the ref:

```ts
ref.current?.play()
ref.current?.pause()
ref.current?.setQuality(720)        // or 'auto'
ref.current?.toggleFullscreen()
ref.current?.video()                 // raw HTMLVideoElement
ref.current?.player()                // raw HakariPlayer (vanilla)
```

### Theming

```tsx
<HakariPlayer
  src={signedUrl}
  theme={{
    accent: '#ff3a8c',          // seekbar fill, scrub handle, active menu
    text: '#fff',
    live: '#ff3b3b',
    overlay: 'rgba(0,0,0,0.85)', // controls bar gradient peak
    menuBg: 'rgba(20,20,28,0.95)',
    menuBorder: 'rgba(255,255,255,0.08)',
    hover: 'rgba(255,255,255,0.15)',
  }}
/>
```

Each slot maps to a CSS variable on the player root (`--hakari-accent`,
`--hakari-text`, `--hakari-live`, `--hakari-overlay`, `--hakari-menu-bg`,
`--hakari-menu-border`, `--hakari-hover`). Pass any subset; unset slots
fall back to the built-in dark defaults. For repo-wide theming, write
to those variables from your own CSS targeting `.hakari-player` instead
of passing the prop on every instance.

`accentColor="#ff3a8c"` is kept as a shorthand for `theme={{ accent: ... }}`.

### Hiding individual controls

```tsx
<HakariPlayer
  src={signedUrl}
  controls={{ quality: false, fullscreen: false }}  // hide just these two
/>
<HakariPlayer src={signedUrl} controls={false} />   // hide all controls
```

`react` and `react-dom` are declared as **optional peer dependencies**.
The vanilla `@hakari/web-player` import has zero React payload — only
customers who `import` from `@hakari/web-player/react` pay for the wrapper.

## Browser support

- Chrome / Edge / Firefox: hls.js (MSE).
- Safari (macOS / iOS): native HLS via `<video src=…>`.

## Development

```sh
git clone git@github.com:hakari-cloud/web-player.git
cd web-player
npm install
npm run example   # vite dev server with examples/index.html
npm run build     # produces dist/{esm,cjs,d.ts}
```

## License

MIT
