// ============================================================================
// DEMO STEP 5 (optional follow-up to the backend reveal).
//
// Live on the projector, after backend traces/metrics/logs are flowing:
//   1. npm install @hyperdx/browser
//   2. Uncomment the `import` line AND the `HyperDX.init({...})` block below
//   3. Hard-reload the browser tab (Cmd-Shift-R) so Vite re-bakes the bundle
//
// Once enabled you get:
//   - Distributed traces propagated browser → backend (the `fetch /api/*`
//     spans share a trace ID with the Express handler spans, via the
//     `traceparent` header)
//   - Session replays — synchronised video of every click/scroll, scrubbable
//     from the trace timeline in ClickStack
//   - Browser console.log / network / unhandled-error capture
//
// No extra .env edits required. `__OTLP_ENDPOINT__` and `__OTLP_AUTH_TOKEN__`
// are compile-time constants injected by vite.config.ts; the endpoint is
// `OTEL_EXPORTER_OTLP_ENDPOINT` and the token is parsed out of
// `OTEL_EXPORTER_OTLP_HEADERS` (or `HYPERDX_API_KEY`) — the same vars the
// backend already uses. ./run.sh rebuilds, so a fresh tab reload picks them up.
//
// SECURITY NOTE: the token ships in the public browser bundle. Anyone
// reading your booth laptop's network tab can copy it. Use a throwaway
// demo-scoped ingestion token, never your production one.
// ============================================================================

// import HyperDX from '@hyperdx/browser';

export function initTelemetry(): void {
  // HyperDX.init({
  //   url: __OTLP_ENDPOINT__,
  //   apiKey: __OTLP_AUTH_TOKEN__,
  //   service: 'hn-analyzer-web',
  //   tracePropagationTargets: [/localhost:5001/i, /\/api\//i],
  //   consoleCapture: true,
  //   advancedNetworkCapture: true,
  // });
}

// recordAction() stays a no-op by default. Session replay already captures
// clicks and scrolls automatically — you don't need this for the headline
// demo. If you want named markers on the replay timeline (Dashboard-Refresh
// firing every 15s, Search-Submitted on every search), also uncomment the
// HyperDX.addAction line below after Step 5.
export function recordAction(
  name: string,
  attrs?: Record<string, string | number | boolean>,
): void {
  // HyperDX.addAction(name, attrs);
}
