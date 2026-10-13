/**
 * Langfuse export for chat traces.
 *
 * Uses an isolated tracer provider so chat spans are not registered on the
 * global OpenTelemetry provider. A second processor exports correlation-safe
 * copies to ClickStack when the request's ClickStack instrumentation is active.
 * Both destinations receive the same trace/span IDs; collector HTTP spans
 * remain outside Langfuse.
 *
 * Call `initLangfuse()` only after environment variables are loaded.
 * Without both API keys this is a no-op and chat still answers.
 */

import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { NodeTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { createClickStackChatProcessor } from './chat-telemetry';

const ENVIRONMENT_NAME = /^(?!langfuse)[a-z0-9-_]{1,40}$/;
const SECRET_KEY = /^(api[-_]?key|authorization|secret|password|token)$/i;

let processor: LangfuseSpanProcessor | null = null;
let clickstackProcessor: SpanProcessor | undefined;
let started = false;

function tracingEnvironment(): string {
  const candidates = [process.env.LANGFUSE_TRACING_ENVIRONMENT, process.env.VERCEL_ENV, 'development'];
  for (const candidate of candidates) {
    const value = candidate?.trim().toLowerCase() ?? '';
    if (ENVIRONMENT_NAME.test(value)) return value;
  }
  return 'development';
}

function maskString(value: string): string {
  return value
    .replace(/\b(?:sk|pk)-lf-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED EMAIL]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED CARD]');
}

function maskValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, maskValue(child, childKey)]));
  }
  return value;
}

function ensureContextManager(): void {
  // The API's default context manager ignores active spans, so nested
  // observations would each become their own trace. Register async hooks
  // only when nothing else (ClickStack's SDK, for example) already did.
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  if (!context.setGlobalContextManager(manager)) manager.disable();
}

export function initLangfuse(): LangfuseSpanProcessor | null {
  if (started) return processor;
  started = true;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    console.log('[langfuse] tracing disabled; set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    return null;
  }
  ensureContextManager();
  processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com',
    environment: tracingEnvironment(),
    exportMode: process.env.VERCEL ? 'immediate' : 'batched',
    mask: ({ data }) => maskValue(data),
  });
  // Do not call register(): that would replace the global provider used by ClickStack.
  clickstackProcessor = createClickStackChatProcessor();
  setLangfuseTracerProvider(new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'hn-analyzer-api' }),
    spanProcessors: [processor, ...(clickstackProcessor ? [clickstackProcessor] : [])],
  }));
  console.log(`[langfuse] tracing enabled (${tracingEnvironment()})`);
  return processor;
}

export function langfuseActive(): boolean {
  return processor !== null;
}

export async function flushLangfuse(): Promise<void> {
  const results = await Promise.allSettled([processor?.forceFlush(), clickstackProcessor?.forceFlush()]);
  if (results.some((result) => result.status === 'rejected')) throw new Error('Chat telemetry export failed');
}
