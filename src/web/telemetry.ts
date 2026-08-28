// Browser SDK is enabled on the `instrumented` branch.
//
// HyperDX.init gives you:
//   - Distributed traces propagated browser → backend (the `fetch /api/*`
//     spans share a trace ID with the Express handler spans, via the
//     `traceparent` header)
//   - Session replays — synchronised video of every click/scroll, scrubbable
//     from the trace timeline in ClickStack
//   - Browser console.log / network / unhandled-error capture
//
// `__OTLP_ENDPOINT__` and `__OTLP_AUTH_TOKEN__` are compile-time constants
// injected by vite.config.ts from OTEL_EXPORTER_OTLP_ENDPOINT and
// OTEL_EXPORTER_OTLP_HEADERS (or HYPERDX_API_KEY).
//
// SECURITY NOTE: the token ships in the public browser bundle. Use a
// throwaway demo-scoped ingestion token, never your production one.

import HyperDX from '@hyperdx/browser';

export function initTelemetry(): void {
  HyperDX.init({
    url: __OTLP_ENDPOINT__,
    apiKey: __OTLP_AUTH_TOKEN__,
    service: 'hn-analyzer-web',
    tracePropagationTargets: [/localhost:5001/i, /\/api\//i],
    consoleCapture: true,
    advancedNetworkCapture: true,
  });
}

export function recordAction(
  name: string,
  attrs?: Record<string, string | number | boolean>,
): void {
  HyperDX.addAction(name, attrs);
}
