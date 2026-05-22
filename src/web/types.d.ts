// Vite alias for the Click UI bundled CSS (defined in vite.config.ts).
declare module '@cui-styles';

// Compile-time string constants injected by `define` in vite.config.ts.
// Sourced from .env (OTEL_EXPORTER_OTLP_ENDPOINT + the bearer token parsed
// out of OTEL_EXPORTER_OTLP_HEADERS, or HYPERDX_API_KEY as a fallback).
// Empty strings if the corresponding .env value is unset.
declare const __OTLP_ENDPOINT__: string;
declare const __OTLP_AUTH_TOKEN__: string;
