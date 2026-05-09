import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Emit .d.ts. We expose a small typed surface (HakariPlayer + options +
  // events); customers deserve real autocomplete.
  dts: true,
  sourcemap: true,
  clean: true,
  // Don't minify — bundle size is dominated by hls.js (~120kB gz). Our
  // wrapper is small and minifying it makes stack traces unreadable in
  // customer apps. They can run their own bundler over us if they want.
  minify: false,
  target: 'es2020',
  treeshake: true,
})
