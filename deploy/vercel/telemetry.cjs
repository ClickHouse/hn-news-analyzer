// This module is loaded only by the Vercel adapter, never by the local demo.
exports.initTelemetry = function initTelemetry() {
  if (!/^(true|1)$/i.test(process.env.OTEL_ENABLED || '') || process.env.OTEL_SDK_DISABLED === 'true') return null;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error('OTEL_ENABLED requires OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
  const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
  const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
  const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { context, propagation, trace, metrics, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
  const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
  const { format } = require('node:util');

  const spans = new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: 5_000 }));
  const logRecords = new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ timeoutMillis: 5_000 }) });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ timeoutMillis: 5_000 }),
    exportIntervalMillis: 60_000, exportTimeoutMillis: 5_000,
  });
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'hn-analyzer-api',
      'deployment.environment.name': process.env.VERCEL_ENV || 'development',
      'cloud.provider': 'vercel',
    }),
    spanProcessors: [spans], logRecordProcessors: [logRecords], metricReaders: [metricReader],
    instrumentations: [
      new HttpInstrumentation({ disableIncomingRequestInstrumentation: true }),
      new UndiciInstrumentation(), new ExpressInstrumentation(),
    ],
  });
  sdk.start();
  const tracer = trace.getTracer('hn-vercel');
  const logger = logs.getLogger('hn-vercel');
  const meter = metrics.getMeter('hn-vercel');
  const requests = meter.createCounter('http.server.requests');
  const duration = meter.createHistogram('http.server.request.duration', { unit: 's' });

  // Preserve Vercel's console output while producing correlated OTLP log records.
  for (const [method, severity] of Object.entries({ log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' })) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      logger.emit({ severityNumber: SeverityNumber[severity], severityText: severity, body: format(...args) });
    };
  }

  return {
    async flush() {
      // allSettled waits for every signal even when one exporter fails.
      const results = await Promise.allSettled([spans.forceFlush(), logRecords.forceFlush(), metricReader.forceFlush()]);
      if (results.some((result) => result.status === 'rejected')) throw new Error('Telemetry export failed');
    },
    withRequest(req, res, run, complete) {
      const method = req.method || 'GET';
      const parent = propagation.extract(context.active(), req.headers);
      return tracer.startActiveSpan(method, { kind: SpanKind.SERVER }, parent, (span) => {
        const start = performance.now();
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          res.off('finish', finish); res.off('close', finish);
          // Only route templates, never query strings, questions, or headers.
          const route = typeof req.route?.path === 'string' ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
          const attrs = { 'http.request.method': method, 'http.route': route, 'http.response.status_code': res.statusCode };
          span.updateName(`${method} ${route}`);
          span.setAttributes(attrs);
          if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          requests.add(1, attrs); duration.record((performance.now() - start) / 1_000, attrs);
          complete();
        };
        res.once('finish', finish); res.once('close', finish);
        try { return run(); }
        catch (err) { span.setStatus({ code: SpanStatusCode.ERROR }); finish(); throw err; }
      });
    },
  };
};
