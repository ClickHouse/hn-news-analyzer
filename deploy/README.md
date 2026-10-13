# Vercel + Cloud Run collector

Prepared against official documentation on 2026-10-12. The deployment targets and
credentials can be chosen later; these files do not provision anything by themselves.

```text
Browser → Vercel (React assets + Express API) → HackerNews ClickHouse database
                         │                   → ClickHouse inference service
                         └─ OTLP/HTTP → Cloud Run collector → Managed ClickStack
```

The HackerNews data connection and ClickStack telemetry connection are separate.
The collector needs **ClickStack's** database credentials. The Vercel app keeps
using the existing HackerNews connection.

## Decisions and current documentation

- **Official:** Managed ClickStack hosts ClickHouse and the UI; you still run the
  collector. Use the [ClickStack collector image](https://clickhouse.com/docs/clickstack/ingesting-data/collector).
- **Derived:** use a Cloud Run **service** for this HTTP ingestion gateway.
  [Jobs run to completion and do not serve requests](https://cloud.google.com/run/docs/create-jobs).
  A Job is suitable for a one-off telemetry generator, not the receiving collector.
- **Official:** enable [instance-based CPU allocation](https://cloud.google.com/run/docs/configuring/billing-settings)
  so the collector can batch and retry between requests. This template keeps one
  instance running; expect ongoing CPU/memory charges even with no traffic.
- **Derived:** start the demo with one vCPU, 2 GiB, and one instance. This matches
  the pinned collector's 1500 MiB memory limiter. It is a demo starting point,
  not a production capacity estimate. Queues are in memory: restarts or a long
  backend outage can lose buffered data. There is no durable broker in this setup.
- **Official / `insert-batch-size`:** keep the collector's batch processor. The
  [2.40.0 defaults](https://github.com/hyperdxio/hyperdx/blob/%40hyperdx%2Fotel-collector%402.40.0/docker/otel-collector/config.yaml)
  flush at 10,000 records or five seconds, avoiding tiny inserts for every event.

The pinned image is `docker.io/clickhouse/clickstack-otel-collector:2.40.0`
([release](https://github.com/hyperdxio/hyperdx/releases/tag/%40hyperdx%2Fotel-collector%402.40.0)).
It already includes OTLP receivers, ClickHouse exporters, schema setup, batching,
and static-token authentication. **No Dockerfile, image build, or Artifact Registry
repository is needed** for this path. Cloud Run resolves the tag to a digest when deployed.

## 1. Prepare the collector's ClickHouse credentials

Use an existing dedicated ingest account if available. Otherwise create a new
`hn_otel_ingest` account in the ClickHouse service backing ClickStack. Do not
rotate a shared existing collector's password.

The following creates private files outside the repository, once. It refuses to
overwrite existing secrets:

```bash
HN_SECRETS_DIR="$HOME/.config/hn-clickstack"
mkdir -p "$HN_SECRETS_DIR"
chmod 700 "$HN_SECRETS_DIR"
(
  umask 077
  set -C
  openssl rand -hex 32 | tr -d '\n' > "$HN_SECRETS_DIR/otlp-token"
  { openssl rand -hex 24 | tr -d '\n'; printf 'Aa1-'; } > "$HN_SECRETS_DIR/clickhouse-password"
)
```

If either file already exists, reuse it; do not regenerate it accidentally. The
password uses URL-safe characters for the collector's migration connection URL.

Generate a setup SQL file with a SHA-256 hash, so plaintext isn't included in SQL:

```bash
HN_PASSWORD_HASH=$(openssl dgst -sha256 "$HN_SECRETS_DIR/clickhouse-password" | awk '{print $NF}')
( umask 077
  cat > "$HN_SECRETS_DIR/create-ingest-user.sql" <<SQL
CREATE DATABASE IF NOT EXISTS otel;
CREATE USER hn_otel_ingest IDENTIFIED WITH sha256_hash BY '$HN_PASSWORD_HASH';
GRANT SELECT, INSERT, CREATE DATABASE, CREATE TABLE, CREATE VIEW ON otel.* TO hn_otel_ingest;
SQL
)
unset HN_PASSWORD_HASH
```

Run those statements in the target service's SQL console as an administrator.
These are the [documented ingest privileges](https://clickhouse.com/docs/clickstack/ingesting-data/collector#creating-an-ingestion-user).
Do not run the CREATE USER statement if you are reusing an existing account.
Use the existing database/schema settings when attaching to existing telemetry;
review collector migration compatibility before upgrading an existing collector version.

Record the target service's HTTPS endpoint, e.g.
`https://SERVICE.REGION.gcp.clickhouse.cloud:8443`. This is a database URL, not
an OTLP receiver URL. If the service has an IP allowlist, arrange permitted egress
from Cloud Run (VPC + Cloud NAT with a static address) before deploying. Do not
broaden an existing database allowlist just to get the demo running.

## 2. Put the two secrets in Google Secret Manager

Choose a project and region. The values below are placeholders; no target is
hardcoded in the deployment script. Reauthenticate first if gcloud reports an
expired session.

```bash
gcloud auth login
export GCP_PROJECT=YOUR_PROJECT_ID
export GCP_REGION=us-central1
export HN_SECRETS_DIR="$HOME/.config/hn-clickstack"
export HN_COLLECTOR_SA="hn-otel-collector@${GCP_PROJECT}.iam.gserviceaccount.com"

gcloud services enable run.googleapis.com secretmanager.googleapis.com --project "$GCP_PROJECT"
gcloud iam service-accounts create hn-otel-collector --project "$GCP_PROJECT" \
  --display-name='HackerNews OpenTelemetry collector'

gcloud secrets create hn-clickstack-password --project "$GCP_PROJECT" \
  --replication-policy=automatic --data-file="$HN_SECRETS_DIR/clickhouse-password"
gcloud secrets create hn-otlp-token --project "$GCP_PROJECT" \
  --replication-policy=automatic --data-file="$HN_SECRETS_DIR/otlp-token"

for secret in hn-clickstack-password hn-otlp-token; do
  gcloud secrets add-iam-policy-binding "$secret" --project "$GCP_PROJECT" \
    --member="serviceAccount:$HN_COLLECTOR_SA" --role=roles/secretmanager.secretAccessor
done
```

If the service account/secrets already exist, reuse them and their current secret
version numbers. For deliberate rotation, add a new version with
`gcloud secrets versions add ... --data-file=...`, then update the deployment's
numeric version reference. The account only needs access to these two secrets.
The person deploying also needs Cloud Run deployment permissions and permission
to act as that service account. See [Cloud Run secrets](https://cloud.google.com/run/docs/configuring/services/secrets).

## 3. Deploy the prebuilt collector

From the repository root:

```bash
cp deploy/cloud-run/collector.env.example deploy/cloud-run/collector.env
# Edit collector.env: project, region, service account, ClickStack endpoint,
# ingest username/database, and Secret Manager names + version numbers.
bash deploy/cloud-run/deploy.sh             # review the command; no cloud changes
bash deploy/cloud-run/deploy.sh --apply     # deploy when ready
```

The service exposes its HTTPS URL on **443**; Cloud Run forwards to the
collector's internal HTTP port **4318**. Use the returned `https://...run.app`
base URL in SDK settings, with no `:4318` suffix and no `/v1/traces` suffix.
The SDK appends `/v1/traces`, `/v1/logs`, and `/v1/metrics` itself.

The Cloud Run endpoint has public network ingress and disables the Google IAM
invoker check because ordinary OTLP SDKs use the collector token. Authentication
is enforced **inside the collector** by `OTLP_AUTH_TOKEN`. Send
`authorization=<raw-token>`, **without `Bearer `**. The database password stays
in the collector. TLS terminates at Cloud Run; the collector connects to
ClickHouse over HTTPS. See [Cloud Run public access](https://cloud.google.com/run/docs/authenticating/public).
If your organization requires IAM-authenticated ingress, use an approved proxy
or workload identity setup instead of applying this public-ingress template.

The startup probe waits up to four minutes for the receiver, including first-run
schema setup. Root `/` is not a health URL on the OTLP port; a 404 there does not
mean ingestion is broken. gRPC is not exposed by this single-port configuration.

## 4. Verify actual ingestion

Create a private file outside the repo, e.g. `$HN_SECRETS_DIR/client.env`, containing:

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=https://YOUR_COLLECTOR.run.app
OTEL_EXPORTER_OTLP_HEADERS=authorization=YOUR_RAW_OTLP_TOKEN
```

Set mode `0600`. Then, with Node 22+:

```bash
node --env-file="$HN_SECRETS_DIR/client.env" scripts/verify-collector.mjs
```

This sends one synthetic trace, log, and gauge. It prints status only, never the
token. After at least five seconds, open Managed ClickStack and filter to the
last 15 minutes and `service.name=hn-collector-smoke`. Verify all three signals.
The script reports receiver acceptance; only seeing data in ClickStack confirms
that the collector exported it into the database.

For an ingestion failure, inspect the service logs in Cloud Run. Common causes:
wrong database credentials, missing grants, a sleeping/unreachable ClickHouse
service, an IP allowlist, or a wrong token. A startup failure before the receiver
opens often means schema migration or database authentication failed.

## 5. Deploy the app to Vercel

Import this repository into the chosen Vercel project, with repository root as
Root Directory. Select **Node.js 22.x or 24.x**, and use the checked-in
`vercel.json` settings:

- Vite frontend at `dist/web`, served from Vercel's CDN.
- One Node Function at `api/index.js`, forwarding `/api/*` to the Express app.
- `npm ci --include=dev && npm ci --prefix deploy/vercel --omit=dev`, then `npm run build`.
- 60-second function limit, covering the chat's 25-second timeout and telemetry flush.

Set these as **server environment variables** for each desired Vercel environment
(Preview / Production), then redeploy:

```dotenv
CHAT_ENABLED=true
CLICKHOUSE_INFERENCE_MODEL=gemini-3.8-flash
CLICKHOUSE_INFERENCE_API_KEY=<inference-key>
CLICKHOUSE_INFERENCE_BASE_URL=https://YOUR_INFERENCE_GATEWAY

OTEL_ENABLED=true
OTEL_SERVICE_NAME=hn-analyzer-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://YOUR_COLLECTOR.run.app
OTEL_EXPORTER_OTLP_HEADERS=authorization=<raw-collector-token>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Optional chat traces. Independent of OTEL_ENABLED.
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=production
```

The ClickHouse inference endpoint must be reachable from Vercel's region.
Use the inference gateway provisioned for this deployment.

Optional `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, and
`CLICKHOUSE_DATABASE` configure the HackerNews data source. Omitting them keeps
the public HackerNews demo connection. Do not set these to the collector's
ClickStack ingest account. Keep `SELF_TRAFFIC` off on Vercel.

`OTEL_ENABLED=false` stops backend telemetry; `CHAT_ENABLED=false` hides/disables
chat. Changing Vercel env values requires a new deployment. Neither flag changes
the other. Keep preview deployment protection enabled while validating the app;
choose audience/access controls before exposing a paid chat endpoint publicly.

The Vercel adapter initializes a small standard OpenTelemetry SDK before importing
the app. It exports API spans, outgoing ClickHouse/inference HTTP spans, correlated
console logs, and request metrics. Chat traces use a separate Langfuse tracer and
are flushed in the same
[`waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)
step, without shutting either SDK down between warm or concurrent requests.
Export failures are logged without failing the app. Collector dependencies live
in `deploy/vercel/package.json`. Langfuse packages are root dependencies. The
local `run.sh` BEFORE/AFTER toggle is unchanged.

Vercel serves static assets without invoking the API. Backend telemetry still
covers API requests. The production build also bakes `OTEL_EXPORTER_OTLP_ENDPOINT`
and the collector token into the browser bundle, so the page sends its own
traces and session replay to the collector. Those show up as service
`hn-analyzer-web`. API spans stay on `hn-analyzer-api` with
`cloud.provider=vercel`.

## Local checks before deploying

```bash
npm ci
npm ci --prefix deploy/vercel
npm run typecheck
npm run test:chat
npm run test:vercel
VERCEL=1 npm run build
```

The Vercel tests use local fake inference/database/OTLP receivers and verify all
three signals, warm/concurrent requests, and disabled mode. They do not deploy to
Vercel or Google Cloud. After deployment, verify `/api/config`, dashboard data,
a real chat answer, and `hn-analyzer-api` logs/traces/metrics in ClickStack.

The exported Express app has no listener or self-traffic loop. Local `run.sh`
still starts the server through `scripts/entrypoint.js`. See
[Vercel's Node runtime](https://vercel.com/docs/functions/runtimes/node-js) and
[OpenTelemetry JS exporters](https://opentelemetry.io/docs/languages/js/exporters/)
for the deployment/runtime behavior this adapter uses.
