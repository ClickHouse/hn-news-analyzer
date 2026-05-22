#!/usr/bin/env bash
# One-script demo runner.
#
# The "before / after" reveal is two commands on the projector:
#   1. npm install @hyperdx/node-opentelemetry
#   2. flip which of the `exec` lines at the bottom of this file is commented
# Then re-run ./run.sh. The audience sees a real install + a 4-word toggle.
#
# Between booth sessions, run ./reset.sh to uninstall the HyperDX SDK and
# restore this file to the canonical BEFORE state.
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and paste the values"
  echo "       from the ClickStack Console → 'Env vars' tab."
  exit 1
fi

# Pre-flight: if the AFTER toggle is selected but the HyperDX SDK isn't
# installed yet, fail fast with a helpful pointer. (Otherwise the SA flips
# the toggle, waits for the build, then gets a confusing `npx` error.)
if grep -qE '^exec npx opentelemetry-instrument' "$0" \
  && [[ ! -d node_modules/@hyperdx/node-opentelemetry ]]; then
  echo "ERROR: AFTER toggle is active but @hyperdx/node-opentelemetry isn't installed."
  echo "       Run this first (it's part of the demo reveal):"
  echo "         npm install @hyperdx/node-opentelemetry"
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

# === DEMO TOGGLE ============================================================
# Flip which line is active to switch between BEFORE and AFTER. Restart with
# ./run.sh after editing.
#
# `scripts/entrypoint.js` is a 2-line shim that does `require('console')` to
# wake up the HyperDX console-capture hook. It's a harmless no-op when run
# without the wrapper (BEFORE), so both paths point at the same entry file —
# the only difference is the `npx opentelemetry-instrument` prefix.
#
# IMPORTANT: AFTER requires `npm install @hyperdx/node-opentelemetry` first.
# That package is intentionally NOT declared in package.json — installing it
# live in front of the audience is half of the demo reveal. The pre-flight
# check above will remind you if you forget.

# BEFORE — plain node, no instrumentation, collector stays silent:
exec node scripts/entrypoint.js

# AFTER — same source, wrapped by HyperDX's opentelemetry-instrument CLI.
# Uncomment the line below AND comment the line above, then re-run ./run.sh.
# exec npx opentelemetry-instrument scripts/entrypoint.js
