
# Instrument the HackerNews Analyzer for ClickStack

This skill instruments an **already cloned** [HackerNews Analyzer](https://github.com/ClickHouse/hn-news-analyzer)
so it exports logs, traces, and metrics over OTLP/HTTP to ClickStack, and enables the browser
SDK for distributed traces and session replay.

The user has already cloned the repo and filled `.env`. Do **not** clone the repository. Do
**not** ask for OTLP endpoint or token values. Read `.env` and use what is there.

The app ships **uninstrumented**. `src/server/` has no OpenTelemetry imports. You add the SDKs
and flip two toggles; you do not change business logic.

**End state:**

- `run.sh` launches via `npx opentelemetry-instrument scripts/entrypoint.js`.
- `src/web/telemetry.ts` calls `HyperDX.init` and `HyperDX.addAction`.
- `./run.sh` is running on [http://localhost:5001](http://localhost:5001) with three
  "Health check passed" lines for `/v1/traces`, `/v1/metrics`, and `/v1/logs`.

Follow the steps in order.

---

## Step 0: Batch permissions

Ask the user once to allowlist these prefixes for the session:

| Prefix | Used for |
| --- | --- |
| `npm …` | install HyperDX SDKs |
| `./run.sh` / `npx …` | start the instrumented app |

Nothing here is destructive. Do not print `.env` or tokens. Do not run `git clone`.

---

## Step 1: Confirm the working directory

The current directory must already be `hn-news-analyzer` (it contains `run.sh` and
`src/web/telemetry.ts`).

If it is not, **stop**. Tell the user to clone the repo, `cd` into it, and re-run the
prompt from that directory. Do not clone it for them.

If `node_modules` is missing, run `npm install`. Requires Node 18+.

---

## Step 2: Confirm `.env` is already filled

The SDKs read standard OpenTelemetry exporter variables from `.env`. They are not hardcoded
in source.

`.env` must already exist and contain real values for:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP/HTTP, port `4318`, including `https://` or `http://`
- `OTEL_EXPORTER_OTLP_PROTOCOL` — `http/protobuf`
- `OTEL_EXPORTER_OTLP_HEADERS` — `authorization=<token>` with no `Bearer` prefix
- `OTEL_SERVICE_NAME=hn-analyzer-api`
- `OTEL_TRACES_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`

Read `.env` (do not echo it back). If the file is missing, still has `YOUR_TENANT`, or
`authorization=` is empty while the destination requires auth, **stop**. Tell the user to
copy `.env.example` to `.env` and paste their OTLP endpoint and ingestion token, then
re-run the prompt. Never invent a token. Never hardcode tokens in source files.

An empty `authorization=` is valid only when the collector is unsecured. The variable must
still be present.

The browser SDK reuses the same `OTEL_EXPORTER_OTLP_*` values. `vite.config.ts` bakes the
endpoint and token into the public bundle. Warn once that the token will be in the browser
bundle, so it should be a throwaway ingestion token.

---

## Step 3: Backend auto-instrumentation

```bash
npm install @hyperdx/node-opentelemetry
```

Do **not** add `@hyperdx/*` or `@opentelemetry/*` imports to `src/server/`.

In `run.sh`, comment the plain `node` `exec` and uncomment the instrumented one:

```diff
-exec node scripts/entrypoint.js
+# exec node scripts/entrypoint.js
-# exec npx opentelemetry-instrument scripts/entrypoint.js
+exec npx opentelemetry-instrument scripts/entrypoint.js
```

Keep launching through `scripts/entrypoint.js`. That shim calls `require('console')` so
console capture wraps `console.log`. Pointing `opentelemetry-instrument` at
`dist/server/index.js` ships traces but silently drops logs.

---

## Step 4: Browser SDK

```bash
npm install @hyperdx/browser
```

In `src/web/telemetry.ts`:

1. Uncomment `import HyperDX from '@hyperdx/browser';`
2. Uncomment the `HyperDX.init({...})` block (`hn-analyzer-web`,
   `tracePropagationTargets` for `localhost:5001` and `/api/`, console and network capture).
3. Uncomment `HyperDX.addAction` in `recordAction()`.

`__OTLP_ENDPOINT__` and `__OTLP_AUTH_TOKEN__` are compile-time constants from `vite.config.ts`.
Do not replace them with literals.

---

## Step 5: Run and verify

If a previous `./run.sh` is still running, stop it. Then:

```bash
./run.sh
```

Confirm the startup banner prints three "Health check passed" lines for `/v1/traces`,
`/v1/metrics`, and `/v1/logs`. If a health check fails, the endpoint or token in `.env` is
wrong — tell the user to fix `.env` and restart. Do not paste the token into chat.

Tell the user to:

1. Open [http://localhost:5001](http://localhost:5001), switch years, and click into stories.
2. In ClickStack, open **Search**, filter to the last 5 minutes, and look for
   `hn-analyzer-api` logs.
3. Open a request trace: Express handler, child HTTP span to
   `sql-clickhouse.clickhouse.com`, correlated `console.log` records.
4. Open **Session Replay** on that trace.

To restore the uninstrumented clone later, they can run `./reset.sh` (that also clears `.env`).
