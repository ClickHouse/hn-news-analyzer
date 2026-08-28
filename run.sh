#!/usr/bin/env bash
# Pre-instrumented runner. The AFTER toggle below is the default on this
# branch: Node is wrapped by `opentelemetry-instrument` so traces, metrics,
# and logs export to ClickStack as soon as .env is filled.
#
# Do not run ./reset.sh here — it uninstalls the SDKs and restores the
# uninstrumented BEFORE toggle. Use main if you want the live install /
# toggle-flip workflow.
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and paste the values"
  echo "       from the ClickStack Console → 'Env vars' tab."
  exit 1
fi

# Pre-flight: fail fast if the wrapper is on but the SDK isn't installed.
if grep -qE '^exec npx opentelemetry-instrument' "$0" \
  && [[ ! -d node_modules/@hyperdx/node-opentelemetry ]]; then
  echo "ERROR: @hyperdx/node-opentelemetry isn't installed."
  echo "       Run: npm install"
  exit 1
fi

echo "==> Sourcing .env (OTEL_EXPORTER_OTLP_ENDPOINT + HYPERDX_API_KEY)"
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "==> Building (server + web)"
npm run build

echo "==> Open http://localhost:5001"

# === TOGGLE =================================================================
# This branch ships with AFTER active. Both paths use scripts/entrypoint.js
# (the 2-line shim that does `require('console')` so HyperDX console capture
# wraps console.log). The only difference is the opentelemetry-instrument
# prefix. @hyperdx/node-opentelemetry is declared in package.json here.

# BEFORE — plain node, no instrumentation:
# exec node scripts/entrypoint.js

# AFTER — same source, wrapped by HyperDX's opentelemetry-instrument CLI.
exec npx opentelemetry-instrument scripts/entrypoint.js
