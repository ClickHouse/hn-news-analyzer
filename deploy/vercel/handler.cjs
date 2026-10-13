// Initialize before loading Express / ClickHouse so outgoing calls are patched.
const telemetry = require('./telemetry.cjs').initTelemetry();
// Load Langfuse only when keys are set, so a collector-only deployment does not
// start a second OpenTelemetry provider.
let flushLangfuse = () => Promise.resolve();
if (process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim()) {
  const langfuse = require('../../dist/server/langfuse.js');
  langfuse.initLangfuse();
  flushLangfuse = () => langfuse.flushLangfuse();
}
const { app } = require('../../dist/server/index.js');
const { waitUntil } = require('@vercel/functions');

function flushTracing() {
  return Promise.allSettled([
    telemetry ? telemetry.flush() : Promise.resolve(),
    flushLangfuse(),
  ]).then((results) => {
    if (results.some((result) => result.status === 'rejected')) {
      process.stderr.write('[otel] Export failed; check collector connectivity and Langfuse credentials.\n');
    }
  });
}

module.exports = function handler(req, res) {
  // Register during the invocation; resolve after finish or client cancellation.
  // Keep both SDKs alive for warm/concurrent requests: forceFlush, never shutdown.
  let complete;
  const finished = new Promise((resolve) => { complete = resolve; });
  waitUntil(finished.then(flushTracing));
  if (!telemetry) {
    res.once('finish', () => complete());
    res.once('close', () => complete());
    return app(req, res);
  }
  return telemetry.withRequest(req, res, () => app(req, res), complete);
};
