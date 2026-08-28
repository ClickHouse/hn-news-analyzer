# HackerNews Analyzer

A HackerNews analyzer that queries the public ClickHouse demo cluster
(`sql-clickhouse.clickhouse.com` → `hackernews.hackernews`). Every chart,
table, and search box is a real ClickHouse query, so every interaction can
produce a trace whose hero span is the HTTPS call from the Node backend
out to ClickHouse, with correlated `console.log` records attached.

![HackerNews Analyzer dashboard with all-time stats and an activity chart of stories and comments](./images/app.png)

This is the **pre-instrumented** branch. `@hyperdx/node-opentelemetry` and
`@hyperdx/browser` are already in `package.json`, `run.sh` launches through
`opentelemetry-instrument`, and `src/web/telemetry.ts` calls `HyperDX.init`.
Fill `.env` and run — no agent prompt or manual wiring required.

If you'd rather instrument the app yourself, switch to
[`agentic-getting-started`](https://github.com/ClickHouse/hn-news-analyzer/tree/agentic-getting-started)
(uninstrumented), fill `.env`, then copy this prompt into Cursor (or another
coding agent), or [open it in Cursor](https://cursor.com/link/prompt?text=Use+curl+to+download%2C+read+and+follow%3A+https%3A%2F%2Fgithub.com%2FClickHouse%2Fhn-news-analyzer%2Fblob%2Fmain%2Fagent.md):

```text
Use curl to download, read and follow: https://github.com/ClickHouse/hn-news-analyzer/blob/main/agent.md
```

Works with Claude Code, Cursor, Codex, and other coding agents. The instructions live in [`agent.md`](https://github.com/ClickHouse/hn-news-analyzer/blob/main/agent.md). To do the steps by hand, follow [Instrument manually](https://github.com/ClickHouse/hn-news-analyzer/blob/agentic-getting-started/README.md#instrument-manually) on that branch.

<details>
<summary>What the agent will do</summary>

1. Confirm the working directory is this clone and `.env` is filled in
2. Install `@hyperdx/node-opentelemetry` and enable `opentelemetry-instrument` in `run.sh`
3. Install `@hyperdx/browser` and enable `HyperDX.init` / `HyperDX.addAction`
4. Run `./run.sh` and verify `/v1/traces`, `/v1/metrics`, and `/v1/logs` health checks pass

</details>

---

## Prerequisites

- **Node 18+** and **npm**.
- A [ClickStack](https://clickhouse.com/cloud/clickstack) service on ClickHouse Cloud. In the Cloud console, open the service, then **ClickStack** → **Configure your OpenTelemetry exporter** → **Env vars**. You need the OTLP endpoint and the ingestion token.
- The public ClickHouse demo cluster is used out of the box (no extra creds).

---

## Configure environment and run

The SDKs read standard OpenTelemetry exporter variables; they are not
hardcoded in source.

```bash
npm install
cp .env.example .env
```

Open `.env` and paste the ClickStack values from the Cloud console:

| Variable | Required | What to set |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes | `https://<id>.otel.<region>.aws.clickhouse.cloud:4318` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | yes | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_HEADERS` | yes | `authorization=<ingestion token>` (no `Bearer ` prefix) |
| `OTEL_SERVICE_NAME` | recommended | `hn-analyzer-api` (already in `.env.example`) |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | recommended | `otlp` (already in `.env.example`) |

Leave placeholders (`YOUR_TENANT`, empty `authorization=`) and exporters
will fail auth. Never commit `.env`.

Frontend session replay reuses the same `OTEL_EXPORTER_OTLP_*` values.
`vite.config.ts` bakes the endpoint and token into the browser bundle at
build time. Use a throwaway ingestion token, not a production one.

Then start the app:

```bash
./run.sh
```

The app is at [http://localhost:5001](http://localhost:5001). Confirm the
startup banner prints three “Health check passed” lines for `/v1/traces`,
`/v1/metrics`, and `/v1/logs`. Click around, then in the Cloud console open
the service → **ClickStack** and complete Getting Started if you have not
already (skip any “set up a collector” screens — you are sending OTLP
directly to ClickStack Cloud).

Do not run `./reset.sh` on this branch — it uninstalls the SDKs and restores
the uninstrumented toggles. Use
[`agentic-getting-started`](https://github.com/ClickHouse/hn-news-analyzer/tree/agentic-getting-started)
if you want that workflow.

---

## What to look at in ClickStack

Click around [http://localhost:5001](http://localhost:5001) and open the
matching traces in ClickStack.

### The headline span: ClickHouse over HTTP

Click around the dashboard, then open the trace for any `GET /api/stats/*`
request. You'll see:

- The Express handler span at the top
- **A child HTTP span pointing at `sql-clickhouse.clickhouse.com:8443`** —
  with real network duration, real byte count
- Correlated `console.log` lines as log records on the same trace

> That ClickHouse span was captured without any instrumentation code in
> the backend: `opentelemetry-instrument` patches Node's http stack.

### Cache hits vs misses

Refresh the dashboard twice in quick succession (the in-memory TTL is 30s).

- First trace: includes the ClickHouse child span.
- Second trace: Express span only — no ClickHouse call.

OTel just made cache effectiveness visible without a line of code.

### The year selector

Pick a year from the dropdown (“2024”, then “2010”, then “All time”). Each
choice issues four fresh ClickHouse queries (overview / timeline / top-users
/ top-domains) with `AND toYear(time) = {year:UInt16}`.

Pull up the trace for `GET /api/stats/top-users?year=2024` and compare to
`?year=2010`:

- 2024 scans ~3.7M rows in ~400ms.
- 2010 scans ~1M rows in ~350ms.
- “All time” scans ~50M rows in ~1.2s (and sometimes hits the cluster's
  memory cap, triggering our retry + stale-cache fallback).

> ClickHouse MergeTree can skip data parts whose `time` range falls
> outside the selected year, so the scan is sub-linear in table size. The
> trace shows the actual wall time.

Each `year` value gets its own 30s cache entry, so changing the dropdown
quickly does not melt the cluster, but spans still appear on cache miss.

### Log ↔ trace correlation

Every `console.log` / `console.warn` line the backend emits is shipped as an
OTel log record with the active trace ID and span ID attached. From any
`/api/stats/*` trace you can pivot straight to its `[http]` / `[cache]` /
`[clickhouse]` log lines, and from any slow-query warning you can jump to
the trace that issued it.

### Browser ↔ backend distributed traces

Every trace gains a new “head” span. Pull up the trace for a `/api/search`
click and you'll see:

- A browser `fetch GET /api/search` span at the top, with browser-side
  timings (DNS, TLS, request, response).
- The Express handler span on the backend, sharing the same trace ID.
- The ClickHouse HTTPS child span, as before.

Walk down the trace: zero coordination between browser and backend SDKs,
just W3C `traceparent` propagation over HTTP.

### Session replay

Pick any recent trace, click the **Session Replay** tab. You'll get a
scrubbable video of the visitor's session. Drag the scrubber: the
highlighted trace in the timeline moves with it, so you can pivot from
“weird click at 0:42” to the exact trace that handled it.

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

## Troubleshooting

**Port 5001 already in use.** Set `PORT=5002 ./run.sh` (and update the URL
you open in the browser).

**ClickStack shows nothing.** Check:

1. `.env` has real values (no `YOUR_*` placeholders, `authorization=` is
   not empty).
2. `OTEL_EXPORTER_OTLP_ENDPOINT` includes the `:4318` port and `https://`
   scheme.
3. The HyperDX startup banner in the terminal lists three “Health check
   passed” lines for `/v1/traces`, `/v1/metrics`, `/v1/logs`. If a health
   check fails, the endpoint or token is wrong.
4. `run.sh` still has the instrumented `exec npx opentelemetry-instrument`
   line active (`tail -5 run.sh`).

**Traces and metrics arrive but logs do not.** Console capture hooks
`require('console')` via `require-in-the-middle`. Most apps never call
that explicitly. They use the global `console`, so the hook never fires
and `console.log` is never wrapped. We work around this with a 2-line
`scripts/entrypoint.js` that does `require('console')` *after* the HyperDX
SDK has installed its hook but *before* our app starts logging. Because
`require('console') === global.console` in Node, that one `require` is
enough to wrap every subsequent `console.*` call. If you bypass the toggle
in `run.sh` and invoke `opentelemetry-instrument` on `dist/server/index.js`
directly, **logs will silently not flow** — point it at
`scripts/entrypoint.js` instead.

You can confirm logs are actually leaving the SDK with the included sink:

```bash
node scripts/otel-sink.js                                # in one terminal
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 \
  npx opentelemetry-instrument scripts/entrypoint.js      # in another
```

Hit a few endpoints. Within ~5s you should see `POST /v1/logs` payloads
printed with `service.name = hn-analyzer-api` and `traceId`/`spanId` on
each record (proof that log↔trace correlation is intact).

**“N panels serving cached data” badge appears.** The public demo cluster is
shared and occasionally hits its global memory cap (e.g.
`MEMORY_LIMIT_EXCEEDED ... current RSS: 343 GiB, maximum: 320 GiB`). The
backend handles this automatically:

1. **Pick a year** (instead of “All time”). That filter usually drops the
   query cost from “scans 50M rows” to “scans 3M rows”.
2. Per-query `max_memory_usage=1 GiB` + `max_threads=4` keeps us a polite tenant.
3. Heavy aggregates use approximations (`uniq` over HyperLogLog instead of
   `uniqExact`, score-filtered `GROUP BY` for all-time top-users / top-domains).
4. On `MEMORY_LIMIT_EXCEEDED` (error code 241), the query retries once after a
   1.5s backoff.
5. If the retry also fails AND we have a recently-cached value, the API serves
   the stale value with `stale: true` and the UI shows the warning badge.

Result: the dashboard keeps working through cluster overload, and the
trace for that failure is still in ClickStack.

**ClickHouse 'connection refused' / timeout.** The public demo cluster may be
under load. The backend already has `request_timeout: 20s` and the queries cap
at `max_execution_time: 10s`. Check connectivity:

```bash
curl https://sql-clickhouse.clickhouse.com:8443/ping
```

Should return `Ok.`. If that fails, you're behind a proxy or the cluster is
having a bad day. Point the app at a different ClickHouse instance via the
`CLICKHOUSE_*` env vars in `.env`.

**Search returns nothing.** The dataset's `time` column maxes out around 2021,
so terms that only became popular after that (e.g. “GPT-4”) return zero
results. Try classic terms: `rust`, `clickhouse`, `bitcoin`, `kubernetes`.

**Fallback self-traffic loop.** If you're running without a browser tab
(for example over SSH), set `SELF_TRAFFIC=1 ./run.sh` so the backend fires
a random dashboard refresh or search every 2–3s.

---

## How “zero code change” works (and where it doesn't)

- **Backend:** still zero `@hyperdx/*` / `@opentelemetry/*` imports in
  `src/server/`. On this branch the SDKs *are* declared in `package.json`.
  Auto-instrumentation is loaded by `opentelemetry-instrument` at process
  start; it patches `express`, `http`, `undici`, and `console` so every
  request handler, ClickHouse HTTPS call, and log line becomes a span or
  log record. Verifiable with:

  ```bash
  rg -n "(@hyperdx|@opentelemetry)" src/server/
  ```

  You'll see no matches in `src/server/`. The packages only appear in
  `package.json`.

  The one operational concession is `scripts/entrypoint.js` — 2 lines that
  do `require('console')` to wake up the HyperDX console-capture hook, then
  require the real compiled server. It's not part of the application source
  tree (`src/server/` stays pure), but it's what makes log capture work
  in Node.

- **Frontend:** browser SDK init lives in `src/web/telemetry.ts` and is
  enabled on this branch. The browser SDK is the one piece that needs to
  be in the source — there's no `opentelemetry-instrument` equivalent for
  the browser — but the rest of `src/web/` has zero OTel imports, and the
  wiring fits in 8 lines of declarative config (URL, token, service name,
  propagation targets, capture flags). It also lives in its own dedicated
  module, so the rest of the app stays untouched.

---

## Project layout

```text
src/
├── server/
│   ├── index.ts        # Express + 6 endpoints + TTL cache. ZERO OTel imports.
│   └── clickhouse.ts   # @clickhouse/client wrapper with sql-clickhouse defaults
└── web/
    ├── index.html
    ├── main.tsx
    ├── App.tsx
    ├── api.ts
    ├── telemetry.ts    # HyperDX.init + addAction (enabled on this branch)
    └── components/
        ├── StatsOverview.tsx
        ├── StoriesTimelineChart.tsx   (Recharts)
        ├── TopUsersTable.tsx
        ├── TopDomainsTable.tsx
        └── SearchPanel.tsx            (Recharts + debounced search)
scripts/
├── entrypoint.js       # 2-line shim: require('console') + require server.
│                       # run.sh wraps this with opentelemetry-instrument.
└── otel-sink.js        # Local OTLP receiver for debugging — prints payloads.

run.sh                  # Instrumented runner (opentelemetry-instrument).
reset.sh                # Strips SDKs and restores the uninstrumented toggles.
                        # Don't run this on the instrumented branch.
.env.example            # OTEL_EXPORTER_OTLP_* template for ClickStack Cloud.
```
