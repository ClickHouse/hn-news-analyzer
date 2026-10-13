const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { gunzipSync } = require('node:zlib');
const http = require('node:http');
const path = require('node:path');

// Decode just OTLP's length-delimited trace fields, without a test dependency.
function fields(bytes) {
  const values = new Map(); let offset = 0;
  function varint() {
    let value = 0n, shift = 0n;
    for (;;) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error('Truncated protobuf');
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return Number(value);
      shift += 7n;
    }
  }
  while (offset < bytes.length) {
    const tag = varint(), field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      const size = varint(), value = bytes.subarray(offset, offset + size); offset += size;
      values.set(field, [...(values.get(field) || []), value]);
    } else if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
  return values;
}
function decodeSpans(bytes, isProto) {
  if (!isProto) return (JSON.parse(bytes).resourceSpans || []).flatMap(r => r.scopeSpans.flatMap(s => s.spans));
  return (fields(bytes).get(1) || []).flatMap(r => (fields(r).get(2) || []).flatMap(s =>
    (fields(s).get(2) || []).map(raw => {
      const f = fields(raw), first = key => f.get(key)?.[0] || Buffer.alloc(0);
      return { traceId: first(1).toString('hex'), spanId: first(2).toString('hex'),
        parentSpanId: first(4).toString('hex'), name: first(5).toString('utf8') };
    })));
}

const agentNames = ['answer-hn-question', 'plan-query', 'retrieve-hackernews'];
for (const [mode, langfuse] of [['hyperdx', true], ['before', true], ['hyperdx', false], ['vercel', true]]) {
  test(`${mode}: chat spans correlate with Langfuse=${langfuse}`, { timeout: 20_000 }, async t => {
    if (mode === 'hyperdx') {
      try { require.resolve('@hyperdx/node-opentelemetry'); }
      catch { t.skip('Install the optional HyperDX SDK to test the local AFTER runner.'); return; }
    }
    const spans = { clickstack: [], langfuse: [] }, payloads = { clickstack: [], langfuse: [] };
    const collector = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
      const source = req.url.startsWith('/langfuse') ? 'langfuse' : 'clickstack';
      if (req.url.includes('/traces') && bytes.length) {
        spans[source].push(...decodeSpans(bytes, req.headers['content-type']?.includes('protobuf')));
        payloads[source].push(bytes);
      }
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/inference')) {
        if (bytes.includes(Buffer.from('FAIL_INFERENCE'))) { res.statusCode = 503; res.end('{}'); return; }
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          kind: 'stories', topic: 'Rust', fromDate: null, toDate: null, sort: 'score', limit: 5,
        }) } }] })); return;
      }
      if (req.url.startsWith('/?')) {
        res.end(JSON.stringify({ id: 1, title: 'PRIVATE_RESULT', score: 12 }) + '\n'); return;
      }
      if (req.headers['content-type']?.includes('protobuf')) {
        res.setHeader('content-type', 'application/x-protobuf'); res.end(); return;
      }
      res.end('{}');
    }).listen(0, '127.0.0.1');
    await once(collector, 'listening');
    t.after(() => { collector.closeAllConnections(); collector.close(); });
    const base = `http://127.0.0.1:${collector.address().port}`;
    const child = fork(path.join(__dirname, 'chat-telemetry-worker.cjs'), [], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, HN_TEST_TELEMETRY: mode,
        OTEL_EXPORTER_OTLP_ENDPOINT: base + '/clickstack', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=TEST_INGEST_SECRET',
        OTEL_SERVICE_NAME: 'hn-correlation-test', OTEL_METRICS_EXPORTER: 'none', OTEL_NODE_RESOURCE_DETECTORS: 'none',
        HDX_STARTUP_LOGS: 'false', OTEL_ENABLED: mode === 'vercel' ? 'true' : 'false',
        LANGFUSE_BASE_URL: base + '/langfuse', LANGFUSE_PUBLIC_KEY: langfuse ? 'pk-lf-test' : '',
        LANGFUSE_SECRET_KEY: langfuse ? 'sk-lf-test' : '',
        CHAT_ENABLED: 'true', CLICKHOUSE_INFERENCE_API_KEY: 'PRIVATE_INFERENCE_KEY',
        CLICKHOUSE_INFERENCE_BASE_URL: base + '/inference', CLICKHOUSE_URL: base },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    t.after(() => child.kill());
    const [{ port }] = await once(child, 'message');
    const ids = ['1', '3', '5'].map(s => s.repeat(32));
    const replies = await Promise.all(ids.map(async (id, i) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json', traceparent: `00-${id}-2222222222222222-01` },
        body: JSON.stringify({ message: i === 2 ? 'FAIL_INFERENCE' : 'PRIVATE_QUESTION', year: 2024 }),
      });
      assert.equal(response.status, i === 2 ? 502 : 200);
      await response.arrayBuffer();
      return response.headers.get('x-trace-id');
    }));
    const flushed = once(child, 'message'); child.send('flush'); await flushed;
    assert.match(output, /\[http\] POST \/api\/chat/);
    if (mode !== 'before') assert.deepEqual(replies, ids);
    if (!langfuse) {
      assert.equal(spans.langfuse.length, 0);
      assert.ok(spans.clickstack.some(s => s.name.startsWith('POST /api/chat')));
      return;
    }
    for (const [i, id] of replies.entries()) {
      const names = i === 2 ? agentNames.slice(0, 2) : agentNames;
      for (const name of names) {
        const lf = spans.langfuse.find(s => s.traceId === id && s.name === name);
        assert.ok(lf, `Missing Langfuse ${name} for ${id}`);
        if (mode !== 'before') {
          const cs = spans.clickstack.find(s => s.traceId === id && s.spanId === lf.spanId);
          assert.ok(cs, `Missing matching ClickStack ${name}`);
          assert.equal(cs.parentSpanId, lf.parentSpanId || '');
          assert.equal(cs.name, lf.name);
        }
      }
    }
    if (mode === 'before') assert.equal(spans.clickstack.length, 0);
    else {
      const exported = Buffer.concat(payloads.clickstack);
      assert.ok(exported.includes(Buffer.from('langfuse.trace.name')));
      assert.ok(exported.includes(Buffer.from('hn-correlation-test')));
      for (const value of ['PRIVATE_QUESTION', 'PRIVATE_RESULT', 'PRIVATE_INFERENCE_KEY', 'TEST_INGEST_SECRET']) {
        assert.ok(!exported.includes(Buffer.from(value)), `ClickStack captured ${value}`);
      }
    }
    assert.ok(Buffer.concat(payloads.langfuse).includes(Buffer.from('PRIVATE_QUESTION')));
  });
}
