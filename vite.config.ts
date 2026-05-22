import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Pull the bearer token out of a standard OTLP headers string like
//   "authorization=abc123,x-foo=bar"
// (Case-insensitive on the key. Trims surrounding whitespace.)
function parseOtlpAuthToken(headersStr: string | undefined): string {
  if (!headersStr) return '';
  const match = headersStr.match(/(?:^|,)\s*authorization\s*=\s*([^,]+)/i);
  return match ? match[1].trim() : '';
}

export default defineConfig(({ mode }) => {
  const projectRoot = path.resolve(__dirname);

  // Load EVERY env var from .env (not just VITE_*-prefixed ones) so the
  // browser bundle can reuse the same OTEL_EXPORTER_OTLP_* values the backend
  // already consumes. We then expose ONLY the two specific values we need
  // (endpoint + bearer token) via `define`, so nothing else accidentally
  // leaks into the bundle. The HYPERDX_API_KEY fallback covers .env files
  // that follow the HyperDX-recommended style instead of the raw-headers one.
  const env = loadEnv(mode, projectRoot, '');
  const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  const otlpAuthToken =
    env.HYPERDX_API_KEY?.trim() ||
    parseOtlpAuthToken(env.OTEL_EXPORTER_OTLP_HEADERS);

  return {
    root: path.resolve(projectRoot, 'src/web'),
    plugins: [react()],
    envDir: projectRoot,
    define: {
      // Compile-time string constants — referenced by src/web/telemetry.ts.
      // Declared in src/web/types.d.ts.
      __OTLP_ENDPOINT__: JSON.stringify(otlpEndpoint),
      __OTLP_AUTH_TOKEN__: JSON.stringify(otlpAuthToken),
    },
    resolve: {
      alias: {
        // Click UI bundles its CSS at this path but doesn't expose it in the
        // package "exports" field, so a bare `import '@clickhouse/click-ui/...'`
        // is blocked by rolldown. Alias to the real file on disk.
        '@cui-styles': path.resolve(
          projectRoot,
          'node_modules/@clickhouse/click-ui/dist/esm/click-ui.css',
        ),
      },
    },
    build: {
      outDir: path.resolve(projectRoot, 'dist/web'),
      emptyOutDir: true,
      sourcemap: true,
      chunkSizeWarningLimit: 2000,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:5001',
      },
    },
  };
});
