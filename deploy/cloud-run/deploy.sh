#!/usr/bin/env bash
# Usage: bash deploy/cloud-run/deploy.sh [--apply]
# Default prints the deployment command without changing Google Cloud.
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f collector.env ]]; then
  echo 'Copy collector.env.example to collector.env and fill in the non-secret settings.' >&2
  exit 1
fi
# This is a local shell configuration file; keep it private and trusted.
# shellcheck disable=SC1091
source collector.env
for key in GCP_PROJECT GCP_REGION COLLECTOR_SERVICE COLLECTOR_SERVICE_ACCOUNT COLLECTOR_IMAGE CLICKHOUSE_ENDPOINT CLICKHOUSE_USER CLICKHOUSE_DATABASE CLICKHOUSE_PASSWORD_SECRET OTLP_TOKEN_SECRET; do
  if [[ -z "${!key:-}" || "${!key}" == *YOUR_* ]]; then
    echo "Set $key in collector.env first." >&2; exit 1
  fi
done
[[ "$CLICKHOUSE_ENDPOINT" == https://* ]] || { echo 'Use the ClickStack HTTPS database endpoint.' >&2; exit 1; }
[[ "$COLLECTOR_IMAGE" != *:latest ]] || { echo 'Pin a collector image version or digest.' >&2; exit 1; }
for key in CLICKHOUSE_PASSWORD_SECRET OTLP_TOKEN_SECRET; do
  [[ "${!key}" =~ ^[a-zA-Z0-9_-]+:[0-9]+$ ]] || { echo "$key must be a secret-name:numeric-version reference." >&2; exit 1; }
done

# Public network entry point; the collector enforces OTLP_AUTH_TOKEN itself.
# Always-allocated CPU allows batching/retries after OTLP responses are sent.
# 2Gi matches the pinned image's 1500MiB memory limiter.
deploy_cmd=(gcloud run deploy "$COLLECTOR_SERVICE"
  --project "$GCP_PROJECT" --region "$GCP_REGION"
  --image "$COLLECTOR_IMAGE" --service-account "$COLLECTOR_SERVICE_ACCOUNT"
  --port 4318 --cpu 1 --memory 2Gi --min 1 --max 1
  --no-cpu-throttling --timeout 60 --concurrency 80
  --no-invoker-iam-check --ingress all
  --startup-probe 'tcpSocket.port=4318,periodSeconds=10,timeoutSeconds=5,failureThreshold=24'
  --set-env-vars "CLICKHOUSE_ENDPOINT=$CLICKHOUSE_ENDPOINT,CLICKHOUSE_USER=$CLICKHOUSE_USER,HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE=$CLICKHOUSE_DATABASE"
  --set-secrets "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASSWORD_SECRET,OTLP_AUTH_TOKEN=$OTLP_TOKEN_SECRET")

case "${1:---dry-run}" in
  --dry-run) printf '%q ' "${deploy_cmd[@]}"; printf '\n' ;;
  --apply)
    "${deploy_cmd[@]}"
    gcloud run services describe "$COLLECTOR_SERVICE" --project "$GCP_PROJECT" --region "$GCP_REGION" --format='value(status.url)'
    ;;
  *) echo 'Usage: bash deploy/cloud-run/deploy.sh [--dry-run|--apply]' >&2; exit 1 ;;
esac
