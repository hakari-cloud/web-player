import { defineConfig } from 'tsup'

/** Standalone IIFE bundle for `<script src=…>` embeds. Inlines hls.js so
 *  customers don't need to wire up an importmap or a second CDN script.
 *  Exposes `window.HakariPlayer` so the embed snippet is a one-liner. */
export default defineConfig({
  entry: { 'web-player.standalone': 'src/index.ts' },
  format: ['iife'],
  globalName: 'HakariPlayerLib',
  // hls.js is normally a runtime dep — for the standalone bundle we
  // inline it. `noExternal` overrides tsup's default node_modules
  // externalization.
  noExternal: ['hls.js'],
  outDir: 'dist',
  dts: false,
  // The IIFE bundle is consumed via CDN as a single drop-in script.
  // Customers debugging usually rebuild from source — we don't need to
  // ship the 2.4 MB standalone source map. ESM/CJS bundles still emit
  // sourcemaps via the main tsup.config.ts.
  sourcemap: false,
  clean: false,
  minify: true,
  target: 'es2020',
  // After tsup writes the IIFE under `window.HakariPlayerLib`, append a
  // tiny shim that flattens `HakariPlayerLib.HakariPlayer` → `HakariPlayer`
  // on the global so the embed snippet reads `new HakariPlayer(…)`.
  footer: { js: 'window.HakariPlayer = window.HakariPlayerLib.HakariPlayer;' },
})
