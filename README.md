# HackerNews Analyzer — ClickStack OTel booth demo

A conference-booth demo showing how to instrument an app with the Datadog SDK and send the observability data to ClickStack.
---

## Prerequisites

- **Node 18+** and **npm**.
- A ClickStack endpoint and an ingestion token. Get them from the
  ClickStack Console → "Configure your OpenTelemetry exporter" → **Env vars** tab.
- Public ClickHouse demo cluster is used out of the box (no creds needed).

---

## One-time setup

[Install the Datadog agent](https://docs.datadoghq.com/agent/?tab=Host-based) and then copy the logs config file across:

```
sudo cp hn-news-analyzer-logs.yaml \
    /opt/datadog-agent/etc/conf.d/hn_news_analyzer.d/conf.yaml
```

Launch ClickStack locally:

```
docker run --name clickstack \
  -p 8080:8080 \
  -p 8123:8123 \
  -p 4317:4317 \
  -p 4318:4318 \
  -p 127.0.0.1:18126:8126 \
  -e ENABLE_DATADOG_RECEIVER=true \
clickhouse/clickstack-all-in-one:latest
```

Navigate to localhost:8080 and then select our user in the bottom-left corner, click on to Team Settings > API and Agents, and copy the Ingestion API Key.

---

## Demo flow

Run the app with Datadog instrumentation:

```bash
./run-datadog.sh
```

Open <http://localhost:5001>. You should see:

- A **year selector** at the top right ("All time" by default).
- 5 BigStats (total rows, stories, comments, authors, span).
- An activity area chart (yearly buckets for "All time", monthly for a single year).
- Top users + top domains tables (scoped to the selected year).
- A search box defaulting to "clickhouse" (always all-time).

The terminal will scroll lines like:

```
[http] GET /api/stats/overview
[cache] miss overview
[clickhouse] 87ms 1 rows
```

Next, we need to add the following config to the Datadog config file (`/opt/datadog-agent/etc/datadog.yaml`) so that it will forward observability data to ClickStack.

```
api_key: "<YOUR_CLICKSTACK_INGESTION_KEY>"

# Metrics destination
dd_url: "http://127.0.0.1:18126"

# ClickStack currently supports the Datadog v2 metrics intake.
use_v3_api:
  series:
    enabled: false

# Trace destination
apm_config:
  enabled: true
  apm_dd_url: "http://127.0.0.1:18126"

# Log destination
logs_enabled: true

logs_config:
  logs_dd_url: "http://127.0.0.1:18126"
  force_use_http: true

# These require Datadog's backend, which we aren't using, so we disable them.
remote_updates: false

remote_configuration:
  enabled: false
```

After we've done that, we can restart the Datadog agent.

If we navigate to localhost:8080, we should see events coming in.
---

## Endpoints quick reference

| Endpoint | Cached | Purpose |
| --- | --- | --- |
| `GET /api/health` | no | ClickHouse ping + uptime |
| `GET /api/stats/overview?year=2024` | 30s | Total rows / stories / comments / authors |
| `GET /api/stats/timeline?year=2024` | 30s | Stories + comments per month (or per year if `year` omitted) |
| `GET /api/stats/top-users?year=2024&limit=10` | 30s | Top users by total karma |
| `GET /api/stats/top-domains?year=2024&limit=10` | 30s | Top story-linked domains |
| `GET /api/search?q=...&year=2024&limit=20` | no | Title search (case-insensitive substring), optionally scoped to a year |
| `GET /api/search/timeline?q=...&year=2024` | no | Per-year mentions all-time, or per-month when `year` is set |

The `year` query param is optional on every `/api/stats/*` endpoint. Omit it
(or pass `year=all`) for all-time aggregates. Cache keys are namespaced per
year, so each selection has its own 30s cache slot.

All queries use parameterized ClickHouse SQL — no string interpolation.

---


## Project layout

```
src/
├── server/
│   ├── index.ts        # Express + 6 endpoints + TTL cache. ZERO OTel imports.
│   └── clickhouse.ts   # @clickhouse/client wrapper with sql-clickhouse defaults
└── web/
    ├── index.html
    ├── main.tsx
    ├── App.tsx
    ├── api.ts
    ├── telemetry.ts    # HyperDX.init — commented out; lit up in optional Step 5
    └── components/
        ├── StatsOverview.tsx
        ├── StoriesTimelineChart.tsx   (Recharts)
        ├── TopUsersTable.tsx
        ├── TopDomainsTable.tsx
        └── SearchPanel.tsx            (Recharts + debounced search)
scripts/
├── entrypoint.js       # 2-line shim: require('console') + require server.
│                       # Run by both toggles of run.sh; the BEFORE toggle
│                       # just calls `node` on it, the AFTER toggle wraps
│                       # it with `opentelemetry-instrument`.
└── otel-sink.js        # Local OTLP receiver for debugging — prints payloads.

run.sh                  # Single demo runner. Edit the toggle at the bottom
                        # to flip between BEFORE (silent) and AFTER (wired).
reset.sh                # Restore run.sh + telemetry.ts to the BEFORE state,
                        # kill stale servers, clear dist/.
```
