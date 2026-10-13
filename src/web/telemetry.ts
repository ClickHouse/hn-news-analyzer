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
//
// An empty url is not "disabled". @hyperdx/browser treats "" as a relative
// base and POSTs to this origin's /v1/traces. Vercel builds leave both
// constants empty so the server collector token never enters the public
// bundle; skip init in that case.

import HyperDX from '@hyperdx/browser';

const browserTelemetryEnabled = Boolean(__OTLP_ENDPOINT__ && __OTLP_AUTH_TOKEN__);

export function initTelemetry(): void {
  if (!browserTelemetryEnabled) return;
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
  if (!browserTelemetryEnabled) return;
  HyperDX.addAction(name, attrs);
}
