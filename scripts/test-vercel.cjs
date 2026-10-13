const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const execFileAsync = promisify(execFile);

async function serve(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function worker(t, env) {
  const child = fork(path.join(__dirname, 'vercel-test-worker.cjs'), [], {
    env: { ...process.env, CHAT_ENABLED: 'false', OTEL_ENABLED: 'false', ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = ''; child.stderr.on('data', (data) => { errors += data; });
  const unexpectedExit = new Promise((_, reject) => child.once('exit', () => reject(new Error(errors || 'Worker exited early'))));
  const message = () => Promise.race([once(child, 'message').then(([value]) => value), unexpectedExit]);
  t.after(() => child.kill());
  const { port } = await message();
  return {
    url: `http://127.0.0.1:${port}`,
    async flush() { const result = message(); child.send('flush'); return result; },
  };
}

test('importing the app starts neither a listener nor the self-traffic loop', () => {
  execFileSync(process.execPath, ['-e', "require('./dist/server/index.js')"], {
    cwd: path.join(__dirname, '..'), timeout: 3_000, env: { ...process.env, SELF_TRAFFIC: '1' },
  });
});

test('Vercel adapter serves original API paths with telemetry and chat disabled', { timeout: 10_000 }, async (t) => {
  const app = await worker(t, {});
  const res = await fetch(`${app.url}/api/config`);
  assert.deepEqual(await res.json(), { chat: { enabled: false, ready: false } });
  assert.equal((await fetch(`${app.url}/api/chat`, { method: 'POST' })).status, 404);
  assert.equal((await app.flush()).sdkLoaded, false);
});

test('warm/concurrent Vercel requests flush all three signals and trace inference + ClickHouse', { timeout: 20_000 }, async (t) => {
  const exports = [];
  const collector = await serve(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    exports.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end();
  });
  const inference = await serve(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      kind: 'stories', topic: 'Rust', fromDate: null, toDate: null, sort: 'score', limit: 5,
    }) } }] }));
  });
  const database = await serve(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 1, title: 'DO_NOT_CAPTURE_ROW', author: 'alice', score: 12, comments: 2, posted: '2024-01-01' }) + '\n');
  });
  const app = await worker(t, {
    CHAT_ENABLED: 'true', CLICKHOUSE_INFERENCE_API_KEY: 'DO_NOT_CAPTURE_KEY',
    CLICKHOUSE_INFERENCE_BASE_URL: inference, CLICKHOUSE_URL: database,
    OTEL_ENABLED: 'true', OTEL_SERVICE_NAME: 'hn-vercel-test',
    OTEL_EXPORTER_OTLP_ENDPOINT: collector, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=test-ingest-token',
  });
  for (let turn = 0; turn < 2; turn++) {
    const responses = await Promise.all([
      fetch(`${app.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'DO_NOT_CAPTURE_QUESTION', year: 2024 }) }),
      fetch(`${app.url}/api/search?q=x`),
    ]);
    assert.equal(responses[0].status, 200);
    assert.equal((await responses[0].json()).rows[0].title, 'DO_NOT_CAPTURE_ROW');
    assert.equal(responses[1].status, 200); await responses[1].text();
    assert.equal((await app.flush()).sdkLoaded, true);
  }
  for (const signal of ['traces', 'logs', 'metrics']) {
    assert.ok(exports.some((e) => e.url === `/v1/${signal}` && e.body.length > 0), `missing ${signal}`);
  }
  assert.ok(exports.every((e) => e.auth === 'test-ingest-token'));
  const all = Buffer.concat(exports.map((e) => e.body));
  assert.ok(all.includes(Buffer.from('hn-vercel-test')));
  assert.ok(all.includes(Buffer.from('POST /api/chat/')));
  assert.ok(all.includes(Buffer.from('/v1/chat/completions')), 'missing inference HTTP span');
  assert.ok(all.includes(Buffer.from(new URL(database).port)), 'missing ClickHouse HTTP span');
  for (const secret of ['DO_NOT_CAPTURE_KEY', 'DO_NOT_CAPTURE_QUESTION', 'DO_NOT_CAPTURE_ROW', 'test-ingest-token']) {
    assert.ok(!all.includes(Buffer.from(secret)), `captured ${secret}`);
  }
});

test('collector smoke test sends correlated trace/log and a metric without printing its token', async (t) => {
  const received = [];
  const collector = await serve(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, 'private-test-token');
    received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  const result = await execFileAsync(process.execPath, [path.join(__dirname, 'verify-collector.mjs')], {
    env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: collector, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=private-test-token' }, timeout: 5_000,
  });
  assert.deepEqual(received.map((r) => r.path), ['/v1/traces', '/v1/logs', '/v1/metrics']);
  const span = received[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  const log = received[1].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(span.traceId, log.traceId);
  assert.ok(!result.stdout.includes('private-test-token'));
});

test('collector smoke test fails on partial rejection', async (t) => {
  const collector = await serve(t, (req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ partialSuccess: { rejectedSpans: '1' } }));
  });
  await assert.rejects(execFileAsync(process.execPath, [path.join(__dirname, 'verify-collector.mjs')], {
    env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: collector }, timeout: 5_000,
  }), (err) => err.code !== 0 && /partially rejected/.test(err.stderr));
});
