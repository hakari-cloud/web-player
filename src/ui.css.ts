/** Stylesheet for the custom <HakariPlayer> UI. Inlined as a string so
 *  we can inject once per page on first mount — no separate CSS file
 *  for customers to import, no CSS-in-JS runtime, no Tailwind dep.
 *
 *  Theming: every accent-colored element reads `--hakari-accent` from
 *  the player root, set via the `accentColor` prop. Override by passing
 *  a different color or by setting `--hakari-accent` higher up the tree. */

export const HAKARI_PLAYER_CSS = `
.hakari-player {
  position: relative;
  width: 100%;
  background: #000;
  overflow: hidden;
  font-family: system-ui, -apple-system, sans-serif;
  --hakari-accent: #3BFFD4;
  user-select: none;
}
.hakari-player video {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
}
.hakari-player.fullscreen, .hakari-player.fullscreen video {
  width: 100vw;
  height: 100vh;
}

/* center play button — visible when paused */
.hakari-center-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: rgba(0,0,0,0.25);
  transition: opacity 200ms;
  opacity: 0;
}
.hakari-player.paused .hakari-center-play {
  opacity: 1;
}
.hakari-center-play svg {
  width: 80px;
  height: 80px;
  fill: rgba(255,255,255,0.9);
  filter: drop-shadow(0 4px 12px rgba(0,0,0,0.5));
}

/* bottom control bar */
.hakari-controls {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  background: linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0));
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: opacity 200ms, transform 200ms;
  opacity: 1;
}
.hakari-player.idle .hakari-controls {
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
}
.hakari-player.paused .hakari-controls {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

/* seekbar */
.hakari-seekbar {
  position: relative;
  height: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
}
.hakari-seekbar-track {
  position: relative;
  width: 100%;
  height: 4px;
  background: rgba(255,255,255,0.25);
  border-radius: 2px;
  overflow: visible;
  transition: height 100ms;
}
.hakari-seekbar:hover .hakari-seekbar-track {
  height: 6px;
}
.hakari-seekbar-buffered {
  position: absolute;
  left: 0; top: 0;
  height: 100%;
  background: rgba(255,255,255,0.4);
  border-radius: 2px;
}
.hakari-seekbar-played {
  position: absolute;
  left: 0; top: 0;
  height: 100%;
  background: var(--hakari-accent);
  border-radius: 2px;
}
.hakari-seekbar-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: var(--hakari-accent);
  border-radius: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  opacity: 0;
  transition: opacity 100ms;
}
.hakari-seekbar:hover .hakari-seekbar-handle,
.hakari-seekbar.scrubbing .hakari-seekbar-handle {
  opacity: 1;
}
.hakari-scrub-tooltip {
  position: absolute;
  bottom: 24px;
  transform: translateX(-50%);
  background: #000;
  border-radius: 4px;
  padding: 2px;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.6);
}
.hakari-scrub-tooltip-time {
  background: rgba(0,0,0,0.85);
  color: #fff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  padding: 2px 6px;
  border-radius: 3px;
  margin-top: 2px;
}

/* control buttons row */
.hakari-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hakari-btn {
  background: transparent;
  border: 0;
  color: #fff;
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  transition: background 100ms;
}
.hakari-btn:hover {
  background: rgba(255,255,255,0.15);
}
.hakari-btn svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}
.hakari-time {
  color: #fff;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}
.hakari-spacer { flex: 1; }

/* live indicator */
.hakari-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  background: rgba(0,0,0,0.6);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.hakari-live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff3b3b;
}
.hakari-live.is-live .hakari-live-dot {
  animation: hakari-pulse 1.6s ease-in-out infinite;
}
.hakari-live.behind {
  cursor: pointer;
  opacity: 0.7;
}
.hakari-live.behind:hover { opacity: 1; }
.hakari-live.behind .hakari-live-dot { background: #888; animation: none; }
@keyframes hakari-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.2); }
}

/* quality menu */
.hakari-menu-wrap { position: relative; }
.hakari-menu {
  position: absolute;
  bottom: 36px;
  right: 0;
  background: rgba(20,20,28,0.95);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 120px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.hakari-menu-item {
  display: block;
  width: 100%;
  background: transparent;
  border: 0;
  color: #fff;
  text-align: left;
  padding: 8px 14px;
  font-size: 12px;
  cursor: pointer;
}
.hakari-menu-item:hover { background: rgba(255,255,255,0.08); }
.hakari-menu-item.active { color: var(--hakari-accent); }
.hakari-menu-item.active::before { content: "✓ "; }
`

let injected = false

/** Inject the stylesheet exactly once per document. Subsequent calls
 *  are no-ops. Safe to call from a useEffect on every player mount. */
export function ensureHakariCss(): void {
  if (injected) return
  if (typeof document === 'undefined') return
  const existing = document.getElementById('hakari-player-css')
  if (existing) { injected = true; return }
  const style = document.createElement('style')
  style.id = 'hakari-player-css'
  style.textContent = HAKARI_PLAYER_CSS
  document.head.appendChild(style)
  injected = true
}
