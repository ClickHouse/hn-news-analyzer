import { context, createContextKey, trace, type Attributes } from '@opentelemetry/api';
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

const EXPORT_TO_CLICKSTACK = createContextKey('hn.chat.export-to-clickstack');
const CORRELATION_ATTRIBUTES = new Set([
  'langfuse.trace.name', 'langfuse.observation.type', 'langfuse.observation.model.name',
  'langfuse.observation.level', 'gen_ai.system', 'gen_ai.request.model',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens',
]);

// Check before entering the isolated Langfuse context. A recording HTTP span
// means the local AFTER runner or the Vercel SDK is active. BEFORE stays silent.
export function withClickStackChatExport<T>(run: () => T): T {
  const enabled = trace.getActiveSpan()?.isRecording() === true;
  return context.with(context.active().setValue(EXPORT_TO_CLICKSTACK, enabled), run);
}

export function createClickStackChatProcessor(): SpanProcessor | undefined {
  if (process.env.OTEL_SDK_DISABLED === 'true' ||
      (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) return;
  const batch = new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: 5_000 }));
  const included = new WeakSet<object>();
  return {
    onStart(span, parent) {
      if (parent.getValue(EXPORT_TO_CLICKSTACK) === true) included.add(span);
    },
    onEnd(span) {
      if (!included.has(span)) return;
      const attributes: Attributes = { 'app.feature': 'chat' };
      for (const [key, value] of Object.entries(span.attributes)) {
        if (CORRELATION_ATTRIBUTES.has(key)) attributes[key] = value;
      }
      // Preserve identity, timing, and hierarchy. Prompt/output data remains in
      // Langfuse; never mutate the span being consumed by its processor.
      const exported: ReadableSpan = {
        name: span.name, kind: span.kind, spanContext: () => span.spanContext(),
        parentSpanContext: span.parentSpanContext,
        startTime: span.startTime, endTime: span.endTime, duration: span.duration,
        status: { code: span.status.code }, attributes, events: [], links: [],
        ended: span.ended, resource: span.resource, instrumentationScope: span.instrumentationScope,
        droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
      };
      batch.onEnd(exported);
    },
    forceFlush: () => batch.forceFlush(),
    shutdown: () => batch.shutdown(),
  };
}
