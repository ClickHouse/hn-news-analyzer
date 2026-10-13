// Node 22+: node --env-file=/private/path/client.env scripts/verify-collector.mjs
// Sends one synthetic trace, log, and metric. No credentials are printed.
import { randomBytes } from 'node:crypto';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');
if (!endpoint) throw new Error('Set OTEL_EXPORTER_OTLP_ENDPOINT to the collector HTTPS base URL.');
const headers = { 'content-type': 'application/json' };
for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS || '').split(',')) {
  const index = pair.indexOf('=');
  if (index > 0) headers[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
}
const service = 'hn-collector-smoke';
const time = BigInt(Date.now()) * 1_000_000n;
const traceId = randomBytes(16).toString('hex');
const spanId = randomBytes(8).toString('hex');
const resource = { attributes: [{ key: 'service.name', value: { stringValue: service } }] };
const scope = { name: 'hn-deployment-check' };
const payloads = {
  traces: { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [{
    traceId, spanId, name: 'collector-smoke', kind: 2,
    startTimeUnixNano: String(time), endTimeUnixNano: String(time + 1_000_000n), status: { code: 1 },
  }] }] }] },
  logs: { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [{
    timeUnixNano: String(time), severityNumber: 9, severityText: 'INFO',
    body: { stringValue: 'HackerNews collector smoke test' }, traceId, spanId,
  }] }] }] },
  metrics: { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [{
    name: 'hn.collector.smoke', gauge: { dataPoints: [{ timeUnixNano: String(time), asInt: '1' }] },
  }] }] }] },
};
for (const [signal, payload] of Object.entries(payloads)) {
  const response = await fetch(`${endpoint}/v1/${signal}`, {
    method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${signal}: HTTP ${response.status}; check URL, token, and collector logs.`);
  const body = await response.json().catch(() => { throw new Error(`${signal}: expected an OTLP JSON response; check the collector URL.`); });
  if (body.partialSuccess && Object.entries(body.partialSuccess).some(([key, value]) => key.startsWith('rejected') && Number(value) > 0)) {
    throw new Error(`${signal}: collector partially rejected telemetry.`);
  }
  console.log(`${signal}: accepted`);
}
console.log(`Now verify service.name=${service} in ClickStack. Acceptance alone does not confirm database storage.`);
