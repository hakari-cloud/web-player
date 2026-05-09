import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries → two output bundles. The React subexport is keyed at
  // `@hakari/player/react` and only pulled in by code that imports it,
  // so non-React consumers don't pay for React typings or the wrapper.
  entry: ['src/index.ts', 'src/react.tsx'],
  // React stays a peer dep — never bundle it in. Users bring their own.
  external: ['react', 'react-dom'],
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
