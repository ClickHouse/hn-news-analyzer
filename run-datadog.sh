#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export DD_SERVICE="${DD_SERVICE:-hn-news-analyzer}"
export DD_ENV="${DD_ENV:-demo}"
export DD_VERSION="${DD_VERSION:-1.0.0}"
export DD_TRACE_AGENT_URL="${DD_TRACE_AGENT_URL:-http://127.0.0.1:8126}"
export DD_LOGS_INJECTION="${DD_LOGS_INJECTION:-true}"
export DD_REMOTE_CONFIGURATION_ENABLED="${DD_REMOTE_CONFIGURATION_ENABLED:-false}"
export HN_LOG_FILE="${HN_LOG_FILE:-/tmp/hn-news-analyzer.log}"
export SELF_TRAFFIC="${SELF_TRAFFIC:-1}"
export PORT="${PORT:-5003}"

echo "==> Building (server + web)"
npm run build

echo "==> Traces: ${DD_TRACE_AGENT_URL}"
echo "==> Logs:   ${HN_LOG_FILE}"
echo "==> App:    http://localhost:${PORT}"

# dd-trace must load before Express, @clickhouse/client, and the application.
exec node \
  --require dd-trace/init \
  --require ./scripts/datadog-console.js \
  scripts/entrypoint.js
