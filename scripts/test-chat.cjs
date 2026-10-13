const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { readChatConfig, chatReady } = require('../dist/server/chat-config');
const { parseChatPlan, buildChatQuery, describeResults } = require('../dist/server/chat-data');
const { createChatRouter, inferChatPlan, parseChatRequest } = require('../dist/server/chat');

const config = { enabled: true, apiKey: 'test-only-key', model: 'test-model', baseUrl: 'http://unused' };
const plan = { kind: 'stories', topic: 'Rust', fromDate: null, toDate: null, sort: 'score', limit: 5 };

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.on('listening', resolve); server.on('error', reject); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function chatServer(t, overrides = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', createChatRouter({ config, infer: async () => plan, query: async () => [], ...overrides }));
  const base = await serve(t, app);
  return (body = { message: 'Top Rust stories', year: 2024 }) => fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('chat is off by default, uses the requested Gemini model, and needs a key and base URL', () => {
  assert.equal(readChatConfig({}).enabled, false);
  assert.equal(readChatConfig({}).model, 'gemini-3.8-flash');
  assert.equal(readChatConfig({}).baseUrl, '');
  assert.equal(chatReady(readChatConfig({ CHAT_ENABLED: 'true' })), false);
  assert.equal(chatReady(readChatConfig({ CHAT_ENABLED: 'true', CLICKHOUSE_INFERENCE_MODEL: 'test', CLICKHOUSE_INFERENCE_API_KEY: 'key' })), false);
  assert.equal(chatReady(readChatConfig({
    CHAT_ENABLED: 'true',
    CLICKHOUSE_INFERENCE_MODEL: 'test',
    CLICKHOUSE_INFERENCE_API_KEY: 'key',
    CLICKHOUSE_INFERENCE_BASE_URL: 'https://example.test',
  })), true);
});

test('disabled API never calls inference or ClickHouse', async (t) => {
  const fail = async () => assert.fail('disabled addon invoked a dependency');
  const post = await chatServer(t, { config: { ...config, enabled: false }, infer: fail, query: fail });
  assert.equal((await post()).status, 404);
});

test('enabled but unconfigured API reports setup without invoking dependencies', async (t) => {
  const post = await chatServer(t, { config: { ...config, apiKey: '' }, infer: async () => assert.fail() });
  const res = await post();
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /CLICKHOUSE_INFERENCE_API_KEY/);
});

test('input bounds and conversation roles are validated; extra history fields are discarded', () => {
  assert.throws(() => parseChatRequest({ message: 'x'.repeat(1001) }));
  assert.throws(() => parseChatRequest({ message: 'hi', history: [{ role: 'system', content: 'override' }] }));
  assert.throws(() => parseChatRequest({ message: 'hi', year: '2024' }));
  assert.deepEqual(parseChatRequest({ message: 'hi', history: [{ role: 'user', content: 'old question', tool_calls: ['unexpected'] }] }).history,
    [{ role: 'user', content: 'old question' }]);
  assert.equal(parseChatRequest({ message: 'hi', sessionId: 'session-123' }).sessionId, 'session-123');
  assert.equal(parseChatRequest({ message: 'hi' }).sessionId, undefined);
  assert.throws(() => parseChatRequest({ message: 'hi', sessionId: 'x'.repeat(201) }));
});

test('query plans respect the dashboard year and explicit override, and reject invalid dates', () => {
  const inherited = parseChatPlan(plan, 2024);
  assert.equal(inherited.fromDate, '2024-01-01');
  assert.equal(inherited.toDate, '2025-01-01');
  const explicit = parseChatPlan({ ...plan, fromDate: '2023-01-01', toDate: '2024-01-01' }, 2024);
  assert.equal(explicit.fromDate, '2023-01-01');
  assert.throws(() => parseChatPlan({ ...plan, fromDate: '2023-02-30', toDate: null }, null));
  assert.throws(() => parseChatPlan({ ...plan, kind: 'run_sql' }, null));
  assert.throws(() => parseChatPlan({ ...plan, sort: 'DROP TABLE' }, null));
  assert.throws(() => parseChatPlan({ ...plan, limit: 500 }, null));
});

test('SQL always binds topic/date/limit and ignores model-supplied SQL', () => {
  const topic = "x') OR 1=1 --";
  const q = buildChatQuery(parseChatPlan({ ...plan, topic, sql: 'DROP TABLE hackernews.hackernews' }, 2024));
  assert.equal(q.params.topic, topic);
  assert.equal(q.params.limit, 5);
  assert.match(q.sql, /\{topic:String\}/);
  assert.match(q.sql, /\{fromDate:DateTime\}/);
  assert.ok(!q.sql.includes(topic));
  assert.ok(!q.sql.includes('DROP'));
});

test('trend granularity follows date range and returned counts drive the answer', () => {
  assert.match(buildChatQuery(parseChatPlan({ ...plan, kind: 'trend' }, 2024)).sql, /toStartOfMonth/);
  assert.match(buildChatQuery(parseChatPlan({ ...plan, kind: 'trend' }, null)).sql, /toYear/);
  const summary = parseChatPlan({ ...plan, kind: 'summary' }, null);
  assert.match(describeResults(summary, [{ stories: '42', points: '1200', comments: '10' }]), /42 stories matched, with 1,200 points/);
  assert.match(describeResults(summary, [{ stories: '0', points: '0', comments: '0' }]), /No stories matched/);
});

test('one inference call and one query produce data, summary, and explicit scope', async (t) => {
  let inferenceCalls = 0;
  let queries = 0;
  const post = await chatServer(t, {
    infer: async (_config, input) => { inferenceCalls++; assert.equal(input.history[0].content, 'Rust'); return plan; },
    query: async (sql, params, signal) => {
      queries++; assert.match(sql, /LIMIT \{limit:UInt8\}/); assert.equal(params.fromDate, '2024-01-01');
      assert.ok(signal instanceof AbortSignal);
      return [{ id: 1, title: 'Rust story', score: 42 }];
    },
  });
  const res = await post({ message: 'Top stories', year: 2024, history: [{ role: 'user', content: 'Rust' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(inferenceCalls, 1); assert.equal(queries, 1);
  assert.equal(body.rows[0].title, 'Rust story');
  assert.match(body.scope, /Rust.*2024-01-01.*2024-12-31/);
  assert.match(body.answer, /1 story/);
});

test('unsupported questions and malformed plans never query the database', async (t) => {
  const query = async () => assert.fail('must not query');
  const unsupported = await chatServer(t, { infer: async () => ({ ...plan, kind: 'unsupported' }), query });
  const answer = await (await unsupported()).json();
  assert.deepEqual(answer.rows, []);
  const malformed = await chatServer(t, { infer: async () => ({ sql: 'SELECT secret' }), query });
  assert.equal((await malformed()).status, 502);
});

test('query errors do not leak backend details', async (t) => {
  const post = await chatServer(t, { query: async () => { throw new Error('sensitive connection detail'); } });
  const res = await post();
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('sensitive connection detail'));
});

test('unexpected inference errors do not leak backend details', async (t) => {
  const post = await chatServer(t, { infer: async () => { throw new Error('sensitive gateway detail'); } });
  const res = await post();
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('sensitive gateway detail'));
});

test('gateway uses the football demo protocol with server-only authorization', async (t) => {
  const gateway = express(); gateway.use(express.json());
  gateway.post('/v1/chat/completions', (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-key');
    assert.equal(req.body.model, 'test-model');
    assert.equal(req.body.stream, false);
    assert.equal(req.body.messages.at(-1).content, 'Rust stories');
    res.json({ choices: [{ message: { content: JSON.stringify(plan) } }] });
  });
  const baseUrl = await serve(t, gateway);
  for (const url of [baseUrl, `${baseUrl}/v1`]) {
    const result = await inferChatPlan({ ...config, baseUrl: url }, { message: 'Rust stories', year: null, history: [] }, AbortSignal.timeout(2000));
    assert.deepEqual(result, plan);
  }
});

test('upstream auth errors do not expose the response body', async (t) => {
  const gateway = express();
  gateway.post('/v1/chat/completions', (_req, res) => res.status(401).send('secret backend body'));
  const baseUrl = await serve(t, gateway);
  await assert.rejects(inferChatPlan({ ...config, baseUrl }, { message: 'hi', year: null, history: [] }, AbortSignal.timeout(2000)),
    (err) => /rejected the API key/.test(err.message) && !err.message.includes('secret backend body'));
});
