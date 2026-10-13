import { Router } from 'express';
import OpenAI, { APIError, APIUserAbortError } from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import type { ChatConfig } from './chat-config';
import { chatReady } from './chat-config';
import { buildChatQuery, describeResults, describeScope, parseChatPlan, type ChatPlan } from './chat-data';
import { langfuseActive } from './langfuse';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { withClickStackChatExport } from './chat-telemetry';

class ChatInferenceError extends Error {}

export interface ChatRequest {
  message: string;
  year: number | null;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Groups follow-up turns in Langfuse. Omitted requests stay ungrouped. */
  sessionId?: string;
}

export function parseChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== 'object') throw new Error('Enter a question.');
  const p = value as Record<string, unknown>;
  if (typeof p.message !== 'string' || !p.message.trim() || p.message.length > 1_000) {
    throw new Error('Enter a question of up to 1,000 characters.');
  }
  const year = p.year ?? null;
  if (year !== null && (!Number.isInteger(year) || Number(year) < 2006 || Number(year) > 2098)) {
    throw new Error('Choose a valid year.');
  }
  const history = p.history ?? [];
  if (!Array.isArray(history) || history.length > 6 || history.some((m) =>
    !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 1_500)) {
    throw new Error('Invalid conversation. Start a new chat.');
  }
  return { message: p.message.trim(), year: year as number | null,
    history: history.map((m) => ({ role: m.role, content: m.content })),
    sessionId: parseSessionId(p.sessionId) };
}

function parseSessionId(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200 || !/^[\x20-\x7E]+$/.test(value)) {
    throw new Error('Invalid conversation. Start a new chat.');
  }
  return value;
}

function inferenceBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
}

// Drop upstream error bodies before the OpenAI SDK stringifies them onto a generation.
async function inferenceFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const response = await fetch(url, init);
  if (response.ok) return response;
  return new Response(JSON.stringify({ error: { message: `HTTP ${response.status}` } }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function planPrompt(input: ChatRequest): string {
  return `Turn a HackerNews data question into ONE JSON object, with no markdown or prose.
Schema: {"kind":"stories|trend|authors|domains|summary|unsupported","topic":"literal title substring or empty string","fromDate":null,"toDate":null,"sort":"score|comments|recent","limit":10}.
The available data is story titles, author names, URL domains, timestamps, scores and comment counts. You cannot read linked articles or comment text.
stories: find/rank stories; sort by score, comments, or recent. trend: story counts by time. authors/domains: rank by story count only. summary: totals of stories, points, comments.
Use unsupported for questions that these operations cannot answer, article-content summaries, comparisons requiring multiple separate queries, instructions unrelated to HackerNews data, or requests for SQL. Never fabricate a factual answer.
topic is ONE short literal substring, not the full question. An empty topic means all stories. There is no author/domain filter; do not misrepresent one as a title filter.
fromDate/toDate are YYYY-MM-DD dates; toDate is exclusive. Set BOTH to null to use the dashboard scope (${input.year ?? 'all time'}). An explicit date in the question overrides the dashboard scope. Today is ${new Date().toISOString().slice(0, 10)}.
Use the conversation to resolve follow-ups such as "same for 2023". limit must be an integer from 1 to 20. Return every schema field. Only use the allowed operations and fields.`;
}

export async function inferChatPlan(config: ChatConfig, input: ChatRequest, signal: AbortSignal): Promise<unknown> {
  const openai = new OpenAI({
    apiKey: config.apiKey,
    baseURL: inferenceBaseUrl(config.baseUrl),
    maxRetries: 0,
    defaultHeaders: { 'x-clickhouse-inference-tags': 'app:hn-news-analyzer,workload:chat' },
    fetch: inferenceFetch,
  });
  // Without an isolated Langfuse provider, observeOpenAI would attach the prompt
  // to whatever global tracer ClickStack is using.
  const client = langfuseActive() ? observeOpenAI(openai, { generationName: 'plan-query' }) : openai;
  let content: unknown;
  try {
    const completion = await client.chat.completions.create({
      model: config.model,
      stream: false,
      max_tokens: 1_024,
      messages: [
        { role: 'system', content: planPrompt(input) },
        ...input.history,
        { role: 'user', content: input.message },
      ],
    }, { signal });
    content = completion.choices[0]?.message?.content;
  } catch (err) {
    if (signal.aborted || err instanceof APIUserAbortError) throw err;
    // Do not expose upstream bodies, credentials, or internal endpoint details.
    const status = err instanceof APIError ? err.status : undefined;
    throw new ChatInferenceError(status === 401 || status === 403
      ? 'The inference service rejected the API key. Check the server configuration.'
      : status
        ? `The inference service is unavailable (${status}). Please try again.`
        : 'Could not reach the inference service. Please try again.');
  }
  if (typeof content !== 'string' || content.length > 8_000) {
    throw new ChatInferenceError('The model returned an invalid query plan. Try a simpler question.');
  }
  try {
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new ChatInferenceError('The model returned an invalid query plan. Try a simpler question.');
  }
}

function retrievalInput(plan: ChatPlan): Record<string, unknown> {
  return {
    kind: plan.kind, topic: plan.topic, fromDate: plan.fromDate, toDate: plan.toDate,
    sort: plan.sort, limit: plan.limit,
  };
}

interface TraceSpan {
  update(attributes: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
    statusMessage?: string;
  }): void;
}

const silentSpan: TraceSpan = { update() {} };

function traceChatTurn(input: ChatRequest, run: (span: TraceSpan) => Promise<void>): Promise<void> {
  if (!langfuseActive()) return run(silentSpan);
  return withClickStackChatExport(() => propagateAttributes({
    traceName: 'answer-hn-question',
    sessionId: input.sessionId,
    tags: ['chat'],
    metadata: { feature: 'chat', year: input.year === null ? 'all' : String(input.year) },
  }, () => startActiveObservation('answer-hn-question', (span) => run(span), { asType: 'agent' })));
}

function traceRetriever<T>(run: (span: TraceSpan) => Promise<T>): Promise<T> {
  if (!langfuseActive()) return run(silentSpan);
  return startActiveObservation('retrieve-hackernews', (span) => run(span), { asType: 'retriever' });
}

interface ChatDependencies {
  config: ChatConfig;
  query: (sql: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>[]>;
  infer?: typeof inferChatPlan;
}

export function createChatRouter({ config, query, infer = inferChatPlan }: ChatDependencies): Router {
  const router = Router();
  // Keep the addon completely unavailable when disabled, even for direct POSTs.
  router.post('/', async (req, res) => {
    if (!config.enabled) { res.status(404).json({ error: 'Chat is disabled.' }); return; }
    if (!chatReady(config)) {
      res.status(503).json({ error: 'Chat needs CLICKHOUSE_INFERENCE_API_KEY and CLICKHOUSE_INFERENCE_BASE_URL in the server configuration.' });
      return;
    }
    let input: ChatRequest;
    try { input = parseChatRequest(req.body); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const started = Date.now();
    const failure: { phase: 'inference' | 'query' } = { phase: 'inference' };
    try {
      await traceChatTurn(input, async (span) => {
        const spanContext = trace.getActiveSpan()?.spanContext();
        if (spanContext && isSpanContextValid(spanContext)) {
          res.setHeader('X-Trace-Id', spanContext.traceId);
          console.log(`[chat] started trace_id=${spanContext.traceId}`);
        }
        // Root input is the user message. The generation holds the full prompt and history.
        span.update({ input: input.message });
        try {
          const raw = await infer(config, input, controller.signal);
          let plan;
          try { plan = parseChatPlan(raw, input.year); }
          catch { throw new ChatInferenceError('The model returned an unsupported query plan. Try a simpler question.'); }
          if (plan.kind === 'unsupported') {
            const answer = 'I can find stories, count stories, show topic trends, and rank authors or domains. Try “Top 5 stories about Rust in 2024”.';
            span.update({ output: answer, metadata: { kind: 'unsupported' } });
            res.json({ answer, scope: '', columns: [], rows: [], elapsedMs: Date.now() - started });
            return;
          }
          failure.phase = 'query';
          const { sql, params, columns } = buildChatQuery(plan);
          const rows = await traceRetriever(async (retrieval) => {
            retrieval.update({ input: retrievalInput(plan) });
            try {
              const found = await query(sql, params, controller.signal);
              retrieval.update({
                output: found,
                metadata: { source: 'hackernews', rowCount: found.length },
              });
              return found;
            } catch (err) {
              const safe = 'The data query could not finish. Try a narrower date range or try again.';
              retrieval.update({ level: 'ERROR', statusMessage: safe, output: safe });
              if (controller.signal.aborted) throw err;
              throw new Error(safe);
            }
          });
          const answer = describeResults(plan, rows);
          span.update({
            output: answer,
            metadata: { kind: plan.kind, scope: describeScope(plan), rowCount: rows.length },
          });
          console.log(`[chat] ${plan.kind} ${rows.length} rows ${Date.now() - started}ms`);
          res.json({ answer, scope: describeScope(plan), columns, rows, elapsedMs: Date.now() - started });
        } catch (err) {
          const safe = controller.signal.aborted
            ? 'This request took too long. Try a narrower date range.'
            : failure.phase === 'query'
              ? 'The data query could not finish. Try a narrower date range or try again.'
              : err instanceof ChatInferenceError
                ? err.message
                : 'Could not reach the inference service. Please try again.';
          span.update({
            level: controller.signal.aborted ? 'WARNING' : 'ERROR',
            statusMessage: safe,
            output: safe,
          });
          if (controller.signal.aborted) throw err;
          throw err instanceof ChatInferenceError ? err : new Error(safe);
        }
      });
    } catch (err) {
      if (res.destroyed) return;
      const message = controller.signal.aborted ? 'This request took too long. Try a narrower date range.' :
        failure.phase === 'query' ? 'The data query could not finish. Try a narrower date range or try again.' :
        err instanceof ChatInferenceError ? err.message : 'Could not reach the inference service. Please try again.';
      console.warn(`[chat] ${failure.phase} failed${controller.signal.aborted ? ' (timeout)' : ''}`);
      res.status(controller.signal.aborted ? 504 : 502).json({ error: message });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }
  });
  return router;
}
