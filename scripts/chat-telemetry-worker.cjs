// Separate process: SDK registration and instrumentation hooks are global.
const mode = process.env.HN_TEST_TELEMETRY;
const pending = [];
let handler;
if (mode === 'vercel') {
  globalThis[Symbol.for('@vercel/request-context')] = {
    get: () => ({ waitUntil: (promise) => pending.push(promise) }),
  };
  handler = require('../api/index');
} else {
  if (mode === 'hyperdx') require('@hyperdx/node-opentelemetry').init();
  require('console');
  require('../dist/server/langfuse').initLangfuse();
  handler = require('../dist/server/index').app;
}
const server = require('node:http').createServer(handler);
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async (message) => {
  if (message !== 'flush') return;
  await Promise.all(pending.splice(0));
  if (mode !== 'vercel') await require('../dist/server/langfuse').flushLangfuse();
  if (mode === 'hyperdx') await require('@hyperdx/node-opentelemetry').shutdown();
  process.send({ flushed: true });
});
