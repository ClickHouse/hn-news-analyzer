// Child-process fixture: each test gets fresh SDK globals and module hooks.
const pending = [];
globalThis[Symbol.for('@vercel/request-context')] = {
  get: () => ({ waitUntil: (promise) => pending.push(promise) }),
};
const handler = require('../api/index');
const server = require('node:http').createServer(handler);
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async (message) => {
  if (message === 'flush') {
    await Promise.all(pending.splice(0));
    process.send({ flushed: true, sdkLoaded: Object.keys(require.cache).some((p) => p.includes('@opentelemetry/sdk-node')) });
  }
  if (message === 'stop') server.close(() => process.exit(0));
});
