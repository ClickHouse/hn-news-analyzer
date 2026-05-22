#!/usr/bin/env bash
# Reset the demo to its pristine "before" state.
#
# Run this between booth sessions to undo whatever you edited during the
# reveal, kill any leftover servers, and drop stale build output so the next
# ./run.sh starts from a clean slate.
#
# What this DOES touch:
#   - run.sh                             → restored: BEFORE active, AFTER commented
#   - src/web/telemetry.ts               → restored to the canonical commented-out
#                                          form (HyperDX.init off)
#   - @hyperdx/node-opentelemetry        → npm uninstalled (Step 2 of the demo)
#   - @hyperdx/browser                   → npm uninstalled (Step 5 of the demo)
#   - dist/                              → removed (forces a fresh build)
#   - .vite/, node_modules/.vite/        → removed (frontend bundle cache)
#   - Any process holding :5001          → killed
#   - Any process holding :14318         → killed (the otel-sink debug receiver)
#   - ClickStack `otel.*` tables         → TRUNCATEd over HTTPS (so the next
#                                          session sees an empty ClickStack UI).
#                                          Requires CLICKHOUSE_HOST / _USER /
#                                          _PASSWORD in .env; skipped otherwise.
#
# What this does NOT touch:
#   - .env                               → never. Your token stays put.
#   - node_modules/ (other than HyperDX) → never. Saves a full re-install.
#   - any other tracked source under src/.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Truncating ClickStack 'otel.*' tables (clean slate for the next session)"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${CLICKHOUSE_HOST:-}" || -z "${CLICKHOUSE_USER:-}" || -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
  echo "    SKIPPED: CLICKHOUSE_HOST / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD not set in .env."
  echo "             Add them to also wipe hyperdx_sessions, otel_logs, otel_traces,"
  echo "             and the five otel_metrics_* tables between booth sessions."
else
  ch_url="https://${CLICKHOUSE_HOST}:8443/?database=otel"
  for t in hyperdx_sessions \
           otel_logs \
           otel_metrics_exponential_histogram \
           otel_metrics_gauge \
           otel_metrics_histogram \
           otel_metrics_sum \
           otel_metrics_summary \
           otel_traces; do
    echo "    TRUNCATE TABLE otel.${t}"
    if ! curl -sS --fail \
              --user "${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}" \
              --data-binary "TRUNCATE TABLE ${t}" \
              "${ch_url}" >/dev/null; then
      echo "    WARN: TRUNCATE failed for otel.${t} — continuing"
    fi
  done
fi

echo "==> Resetting src/web/telemetry.ts (HyperDX.init back to commented out)"
cat > src/web/telemetry.ts <<'TELEMETRY_EOF'
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
TELEMETRY_EOF

echo "==> Resetting run.sh to the BEFORE toggle (plain node, no wrapper)"
cat > run.sh <<'EOF'
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
EOF
chmod +x run.sh

echo "==> Killing anything holding :5001 (app) or :14318 (otel-sink)"
for port in 5001 14318; do
  # lsof exits 1 when nothing matches — don't let set -e trip on that.
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "    killing pid(s) $pids on :${port}"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

for pkg in @hyperdx/node-opentelemetry @hyperdx/browser; do
  if [[ -d "node_modules/${pkg}" ]]; then
    echo "==> Uninstalling ${pkg} (so the next demo can install it live)"
    npm uninstall --no-audit --no-fund "${pkg}" >/dev/null 2>&1 || {
      echo "    npm uninstall failed — falling back to rm -rf node_modules/${pkg}"
      rm -rf "node_modules/${pkg}"
    }
  fi
done
# npm leaves an empty @hyperdx/ scope dir behind — clean it up.
rmdir node_modules/@hyperdx 2>/dev/null || true

echo "==> Removing build output (dist/, .vite/, node_modules/.vite/)"
rm -rf dist .vite node_modules/.vite

echo
echo "Reset complete. Next demo:"
echo "  ./run.sh                                       # 1. collector silent (BEFORE)"
echo "  npm install @hyperdx/node-opentelemetry        # 2. live install"
echo "  # edit run.sh — flip the comment on the exec lines"
echo "  ./run.sh                                       # 3. collector lit up (AFTER)"
echo
echo "Optional Step 5 (browser session replay):"
echo "  npm install @hyperdx/browser                   # 4. live install"
echo "  # edit src/web/telemetry.ts — uncomment 'import' + HyperDX.init({...})"
echo "  ./run.sh                                       # 5. rebuild → reload tab"
