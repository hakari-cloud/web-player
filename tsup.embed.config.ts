import { defineConfig } from 'tsup'

/** Standalone IIFE bundle for `<script src=…>` embeds. Inlines hls.js so
 *  customers don't need to wire up an importmap or a second CDN script.
 *  Exposes `window.HakariPlayer` so the embed snippet is a one-liner. */
export default defineConfig({
  entry: { 'hakari-player.standalone': 'src/index.ts' },
  format: ['iife'],
  globalName: 'HakariPlayerLib',
  // hls.js is normally a runtime dep — for the standalone bundle we
  // inline it. `noExternal` overrides tsup's default node_modules
  // externalization.
  noExternal: ['hls.js'],
  outDir: 'dist',
  dts: false,
  sourcemap: true,
  clean: false,
  minify: true,
  target: 'es2020',
  // After tsup writes the IIFE under `window.HakariPlayerLib`, append a
  // tiny shim that flattens `HakariPlayerLib.HakariPlayer` → `HakariPlayer`
  // on the global so the embed snippet reads `new HakariPlayer(…)`.
  footer: { js: 'window.HakariPlayer = window.HakariPlayerLib.HakariPlayer;' },
})
