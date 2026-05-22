# HackerNews Analyzer — ClickStack OTel booth demo

A conference-booth demo of ClickStack OpenTelemetry instrumentation.

The app is a live HackerNews analyzer that queries the public ClickHouse demo
cluster (`sql-clickhouse.clickhouse.com` → `hackernews.hackernews`). Every chart,
table, and search box is backed by a real ClickHouse query — so every visitor
interaction produces a trace whose hero span is the actual HTTPS call from
the Node backend out to ClickHouse, with correlated `console.log` records
attached.

The point of the demo is the contrast:

- **Before:** plain `node`. Collector silent. `package.json` declares
  exactly zero OTel packages. `src/server/` imports exactly zero OTel
  modules.
- **After:** `npm install @hyperdx/node-opentelemetry` + flip a 4-word
  toggle in `run.sh`. Same application source, same env, same .env. Traces,
  metrics, and logs start streaming.

The reveal is two commands typed live on the projector. No source edits, no
`@opentelemetry/*` imports anywhere in the app code — just one package
install and the addition of a 4-word prefix to the command that launches
Node.

There's also an **optional Step 5** for an extra act after the backend
demo: `npm install @hyperdx/browser` + uncommenting an init block in
`src/web/telemetry.ts` lights up distributed traces (browser → backend)
and session replays.

---

## Prerequisites

- **Node 18+** and **npm**.
- A ClickStack endpoint and an ingestion token. Get them from the
  ClickStack Console → "Configure your OpenTelemetry exporter" → **Env vars** tab.
- Public ClickHouse demo cluster is used out of the box (no creds needed).

---

## One-time setup

```bash
npm install
cp .env.example .env
# Open .env and paste these 2 values from the ClickStack Console:
#   OTEL_EXPORTER_OTLP_ENDPOINT
#   HYPERDX_API_KEY              (the ingestion token)
```

> No extra vars are needed for the optional Step 5 (browser telemetry /
> session replay) — `vite.config.ts` reuses the `OTEL_EXPORTER_OTLP_*`
> values above when the `HyperDX.init({...})` block in
> `src/web/telemetry.ts` is uncommented.

---

## Demo flow

> **Between booth sessions:** run `./reset.sh`. It restores `run.sh` and
> `src/web/telemetry.ts` to their canonical "before" state, `npm uninstall`s
> both HyperDX SDKs (`@hyperdx/node-opentelemetry`, `@hyperdx/browser`) so
> the next demo can install them live, kills any leftover servers on
> `:5001` / `:14318`, and drops the build cache. It's idempotent — safe
> to run whether or not you touched anything during the previous demo. It
> does **not** touch your `.env`.

### 1. The "before" state — collector is silent

```bash
./run.sh
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

The ClickStack dashboard is silent. Show the audience the empty dashboard.

### 2. The reveal — install the SDK live on the projector

Before showing this command, narrate: "look at `src/server/index.ts` and
`src/server/clickhouse.ts` — zero OpenTelemetry imports. Look at
`package.json` — zero OpenTelemetry dependencies. The only thing I'm about
to change is **which** command launches Node, but for that to work I need
the wrapper installed first. Let's do that now."

```bash
npm install @hyperdx/node-opentelemetry
```

This adds ~218 packages (the OTel SDK + bundled auto-instrumentations for
Express, HTTP, Undici, etc.). Takes a few seconds. **It doesn't change a
single line of source code** — `src/server/` still has no OTel imports.

### 3. The reveal — flip the toggle in `run.sh`

The bottom of `run.sh` has two `exec` lines; one is active, the other is
commented. Comment the active one and uncomment the other:

```diff
 # BEFORE — plain node, no instrumentation, collector stays silent:
-exec node scripts/entrypoint.js
+# exec node scripts/entrypoint.js

 # AFTER — same source, wrapped by HyperDX's opentelemetry-instrument CLI.
-# exec npx opentelemetry-instrument scripts/entrypoint.js
+exec npx opentelemetry-instrument scripts/entrypoint.js
```

Four words added to a command line. That's the entire diff.

### 4. Re-run, same script

```bash
# Ctrl-C the previous run, then:
./run.sh
```

`run.sh` now boots the server via `opentelemetry-instrument
scripts/entrypoint.js` (HyperDX SDK pre-loaded — no `node` argument; the
HyperDX CLI runs the script itself). The two-line `scripts/entrypoint.js`
does `require('console')` once to wake up the HyperDX console-capture
hook, then requires the compiled server. See *How "zero code change" works*
below for why that single `require` matters.

> If you forget step 2 and only flip the toggle, `run.sh` will detect
> that and exit with a one-line reminder before doing anything else.

### 5. Optional follow-up — browser session replay

This is an optional second act after the backend traces are flowing. Skip
it if your slot is short; otherwise it's the most visually striking part
of the whole demo. Mechanically it's the same shape as Steps 2–4 but for
the frontend.

**No `.env` changes required.** The browser bundle reuses
`OTEL_EXPORTER_OTLP_ENDPOINT` and the token already inside
`OTEL_EXPORTER_OTLP_HEADERS` (parsed at build time by `vite.config.ts`,
with `HYPERDX_API_KEY` as a fallback). Same vars the backend uses.

```bash
npm install @hyperdx/browser
```

Then on the projector, open `src/web/telemetry.ts` and uncomment exactly
two things:

```diff
-// import HyperDX from '@hyperdx/browser';
+import HyperDX from '@hyperdx/browser';

 export function initTelemetry(): void {
-  // HyperDX.init({
-  //   url: __OTLP_ENDPOINT__,
-  //   apiKey: __OTLP_AUTH_TOKEN__,
-  //   service: 'hn-analyzer-web',
-  //   tracePropagationTargets: [/localhost:5001/i, /\/api\//i],
-  //   consoleCapture: true,
-  //   advancedNetworkCapture: true,
-  // });
+  HyperDX.init({
+    url: __OTLP_ENDPOINT__,
+    apiKey: __OTLP_AUTH_TOKEN__,
+    service: 'hn-analyzer-web',
+    tracePropagationTargets: [/localhost:5001/i, /\/api\//i],
+    consoleCapture: true,
+    advancedNetworkCapture: true,
+  });
 }
```

`__OTLP_ENDPOINT__` / `__OTLP_AUTH_TOKEN__` are string constants Vite
substitutes at build time — no runtime env lookups, no `import.meta.env`
plumbing. Declared in `src/web/types.d.ts`, defined in `vite.config.ts`.

Then restart and hard-reload the tab:

```bash
# Ctrl-C, then:
./run.sh
# In the browser: Cmd-Shift-R (so Vite serves the freshly-baked bundle)
```

What this unlocks in ClickStack:

- **Distributed traces.** Click anything in the UI. The browser's
  `fetch /api/*` span now shares a trace ID with the Express handler
  span — `tracePropagationTargets` makes the SDK inject `traceparent` on
  outgoing `/api/*` requests, OTel on the backend reads it, one trace.
- **Session replays.** Every visitor gets a scrubbable video of their
  session, synced to the trace timeline. Click around a panel, open the
  replay, drag the scrub bar — the trace highlights move with the cursor.
- **Browser-side console capture, network capture, unhandled errors.**

**Optional bonus — named action markers in the replay timeline.** Also
uncomment the single `// HyperDX.addAction(name, attrs);` line in
`recordAction()` (same file). The app already calls `recordAction(...)`
on every dashboard refresh and search submit; this lights those up as
labelled markers you can click in the session replay.

> **Booth ops note.** Session replay is **on by default** once enabled.
> Put a small "demo recording in progress" sign on the laptop, or pass
> `disableReplay: true` inside the `HyperDX.init({...})` block if the
> venue requires it.

> **Security note.** Your OTLP ingestion token is baked into the public
> browser bundle — anyone reading your network tab can lift it. Use a
> throwaway demo-scoped token, never your production one.

---

## What to point at on screen during the demo

Split the projector three ways: **browser tab (left half)**, **terminal
(top-right)**, **ClickStack dashboard (bottom-right)**.

### The headline span: ClickHouse over HTTP

Click around the dashboard, then open the trace for any `GET /api/stats/*`
request. You'll see:

- The Express handler span at the top
- **A child HTTP span pointing at `sql-clickhouse.clickhouse.com:8443`** —
  with real network duration, real byte count
- Correlated `console.log` lines as log records on the same trace

> **This is the punchline.** That ClickHouse span was captured for free, with
> zero code in our backend, just because `opentelemetry-instrument` patches
> Node's http stack.

### Cache hits vs misses

Refresh the dashboard twice in quick succession (the in-memory TTL is 30s).

- First trace: includes the ClickHouse child span.
- Second trace: Express span only — no ClickHouse call.

"OTel just made our cache effectiveness visible without a line of code."

### The year selector — interactive scan-cost demo

Pick a year from the dropdown ("2024", then "2010", then "All time"). Each
choice issues four fresh ClickHouse queries (overview / timeline / top-users
/ top-domains) with `AND toYear(time) = {year:UInt16}`.

Pull up the trace for `GET /api/stats/top-users?year=2024` and compare to
`?year=2010`:

- 2024 scans ~3.7M rows in ~400ms.
- 2010 scans ~1M rows in ~350ms.
- "All time" scans ~50M rows in ~1.2s (and sometimes hits the cluster's
  memory cap, triggering our retry + stale-cache fallback).

> Great moment to narrate predicate pushdown: ClickHouse's MergeTree skips
> entire data parts whose `time` range falls outside the year, so the scan
> is sub-linear in the table size. The trace shows the actual wall time.

Each `year` value gets its own 30s cache entry, so audience members spamming
the dropdown won't melt the cluster — but spans still appear on cache miss.

### Log ↔ trace correlation

Every `console.log` / `console.warn` line the backend emits is shipped as an
OTel log record with the active trace ID and span ID attached. From any
`/api/stats/*` trace you can pivot straight to its `[http]` / `[cache]` /
`[clickhouse]` log lines, and from any slow-query warning you can jump to
the trace that issued it.

### Step 5 only — browser ↔ backend distributed traces

After enabling browser telemetry, every trace gains a new "head" span. Pull
up the trace for a `/api/search` click and you'll see:

- A browser `fetch GET /api/search` span at the top, with browser-side
  timings (DNS, TLS, request, response).
- The Express handler span on the backend, sharing the same trace ID.
- The ClickHouse HTTPS child span, as before.

Walk the audience down the trace and emphasise: zero coordination between
browser and backend SDKs, just W3C `traceparent` propagation over HTTP.

### Step 5 only — session replay

Pick any recent trace, click the **Session Replay** tab. You'll get a
scrubbable video of the visitor's session. Drag the scrubber: the
highlighted trace in the timeline moves with it, so you can pivot from
"weird click at 0:42" to the exact trace that handled it.

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

**ClickStack dashboard shows nothing after flipping the toggle.** Check:

1. `run.sh` actually has the AFTER `exec` line uncommented (and the BEFORE
   one commented). Run `tail -5 run.sh` to eyeball it.
2. `.env` has real values (no `YOUR_*` placeholders).
3. `OTEL_EXPORTER_OTLP_ENDPOINT` includes the `:4318` port and `https://` scheme.
4. The HyperDX startup banner in the terminal lists three "Health check
   passed" lines for `/v1/traces`, `/v1/metrics`, `/v1/logs`. If a health
   check fails, the endpoint or token is wrong.

**Traces and metrics arrive but logs do not.** Two independent things have
to be right for `console.log` lines to show up in ClickStack:

1. **Auth.** The HyperDX log pipeline is separate from the trace/metric
   exporters and only reliably picks up auth from `HYPERDX_API_KEY`. Setting
   `OTEL_EXPORTER_OTLP_HEADERS=authorization=...` is enough for traces and
   metrics but the console-capture exporter can drop env-provided headers,
   so records ship anonymously and the collector rejects them. Use
   `HYPERDX_API_KEY=<your token>` (same value as the ClickStack ingestion
   token) and the SDK will inject the header for all three signals.

2. **The `require('console')` shim.** HyperDX's console instrumentation
   hooks `require('console')` via `require-in-the-middle`. Modern apps never
   call that explicitly — they use the global `console` — so the hook never
   fires and `console.log` is never wrapped. We work around this with a
   2-line `scripts/entrypoint.js` that does `require('console')` *after* the
   HyperDX SDK has installed its hook but *before* our app starts logging.
   Because `require('console') === global.console` in Node, that one
   `require` is enough to wrap every subsequent `console.*` call. If you
   bypass the toggle in `run.sh` and invoke `opentelemetry-instrument` on
   `dist/server/index.js` directly, **logs will silently not flow** — point
   it at `scripts/entrypoint.js` instead.

You can confirm logs are actually leaving the SDK with the included sink:

```bash
node scripts/otel-sink.js                                # in one terminal
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 \
  npx opentelemetry-instrument scripts/entrypoint.js      # in another
```

Hit a few endpoints. Within ~5s you should see `POST /v1/logs` payloads
printed with `service.name = hn-analyzer-api` and `traceId`/`spanId` on
each record (proof that log↔trace correlation is intact).

**"N panels serving cached data" badge appears.** The public demo cluster is
shared and occasionally hits its global memory cap (e.g.
`MEMORY_LIMIT_EXCEEDED ... current RSS: 343 GiB, maximum: 320 GiB`). The
backend handles this automatically:

1. **Pick a year** (instead of "All time") — that filter alone usually drops
   the query cost from "scans 50M rows" to "scans 3M rows" and the cluster
   stops complaining. The most common fix during a demo.
2. Per-query `max_memory_usage=1 GiB` + `max_threads=4` keeps us a polite tenant.
3. Heavy aggregates use approximations (`uniq` over HyperLogLog instead of
   `uniqExact`, score-filtered `GROUP BY` for all-time top-users / top-domains).
4. On `MEMORY_LIMIT_EXCEEDED` (error code 241), the query retries once after a
   1.5s backoff.
5. If the retry also fails AND we have a recently-cached value, the API serves
   the stale value with `stale: true` and the UI shows the warning badge.

Result: the dashboard keeps working through cluster overload — the SA can
narrate the trace for that exact failure mode if the audience is technical.

**ClickHouse 'connection refused' / timeout.** The public demo cluster may be
under load. The backend already has `request_timeout: 20s` and the queries cap
at `max_execution_time: 10s`. Check connectivity:

```bash
curl https://sql-clickhouse.clickhouse.com:8443/ping
```

Should return `Ok.`. If that fails, you're behind a proxy or the cluster is
having a bad day — point the demo at a different ClickHouse instance via the
`CLICKHOUSE_*` env vars in `.env`.

**Search returns nothing.** The dataset's `time` column maxes out around 2021,
so terms that only became popular after that (e.g. "GPT-4") return zero
results. Try classic terms: `rust`, `clickhouse`, `bitcoin`, `kubernetes`.

**Fallback self-traffic loop.** If you're running the demo without a live
browser tab (e.g. SSH'd in), set `SELF_TRAFFIC=1 ./run.sh` to have the
backend fire a random dashboard refresh or search every 2-3s.

---

## How "zero code change" works (and where it doesn't)

- **Backend:** literally zero `@hyperdx/*` / `@opentelemetry/*` imports in
  `src/server/`, AND zero such packages declared in `package.json` (until
  step 2 of the demo). The auto-instrumentation is loaded by
  `opentelemetry-instrument` at process start; it patches `express`,
  `http`, `undici`, and `console` so every request handler, ClickHouse
  HTTPS call, and log line becomes a span or log record. Verifiable with:

  ```bash
  rg -n "(@hyperdx|@opentelemetry)" src/server/ package.json
  ```

  You'll see no matches before the live `npm install`. After it, you'll see
  a single line in `package.json` and nothing in `src/server/`.

  The one operational concession is `scripts/entrypoint.js` — 2 lines that
  do `require('console')` to wake up the HyperDX console-capture hook, then
  require the real compiled server. It's not part of the application source
  tree (`src/server/` stays pure) and the demo narrative can ignore it, but
  it's what makes log capture actually work in modern Node.

- **Frontend (optional Step 5):** browser SDK init lives in
  `src/web/telemetry.ts`, commented out by default. Enabling it requires
  two uncomments (`import` + `HyperDX.init({...})`) and one live
  `npm install @hyperdx/browser`. The browser SDK is the one piece that
  needs to be in the source — there's no `opentelemetry-instrument`
  equivalent for the browser — but the rest of `src/web/` has zero OTel
  imports, and the wiring fits in 8 lines of declarative config (URL,
  token, service name, propagation targets, capture flags). It also lives
  in its own dedicated module, so the rest of the app stays untouched.

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
