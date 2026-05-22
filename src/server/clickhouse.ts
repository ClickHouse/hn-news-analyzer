/**
 * Thin typed wrapper around @clickhouse/client.
 *
 * Defaults point at ClickHouse's public read-only demo cluster, so the SA
 * doesn't need to set CLICKHOUSE_* env vars unless they want to override.
 *
 * No OpenTelemetry / HyperDX imports here. The outgoing HTTPS request to
 * ClickHouse is auto-instrumented by @opentelemetry/instrumentation-http
 * when the process is launched via `opentelemetry-instrument`. That HTTP
 * span — POST sql-clickhouse.clickhouse.com:8443 — is the headline of the
 * demo trace.
 *
 * Reliability concerns (shared public cluster):
 *   - The public demo cluster is multi-tenant; OvercommitTracker may kill
 *     our queries when the cluster's overall RSS is near its cap. We cap
 *     per-query memory + threads to be a polite tenant, and retry once on
 *     code 241 (MEMORY_LIMIT_EXCEEDED).
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client';

export const CLICKHOUSE_URL =
  process.env.CLICKHOUSE_URL ?? 'https://sql-clickhouse.clickhouse.com:8443';
export const CLICKHOUSE_USERNAME = process.env.CLICKHOUSE_USERNAME ?? 'demo';
export const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? '';
export const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? 'hackernews';

// 1 GiB per-query memory cap. Plenty for our aggregates, polite enough that
// the OvercommitTracker is less likely to single us out when the cluster is
// loaded.
const MAX_MEMORY_BYTES = 1_073_741_824;

const client: ClickHouseClient = createClient({
  url: CLICKHOUSE_URL,
  username: CLICKHOUSE_USERNAME,
  password: CLICKHOUSE_PASSWORD,
  database: CLICKHOUSE_DATABASE,
  request_timeout: 20_000,
  clickhouse_settings: {
    max_execution_time: 10,
    max_memory_usage: String(MAX_MEMORY_BYTES),
    max_threads: 4,
  },
});

interface ClickHouseLikeError extends Error {
  code?: string;
  type?: string;
}

function isTransientMemoryError(err: unknown): boolean {
  const e = err as ClickHouseLikeError;
  // Code 241 = MEMORY_LIMIT_EXCEEDED. On the public demo cluster this
  // usually means cluster-wide overcommit, not our query — worth a retry.
  return e?.code === '241' || e?.type === 'MEMORY_LIMIT_EXCEEDED';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function query<T>(
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const exec = async (): Promise<T[]> => {
    const result = await client.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return (await result.json()) as T[];
  };

  const t0 = Date.now();
  try {
    const rows = await exec();
    const ms = Date.now() - t0;
    if (ms > 1000) {
      console.warn(`[clickhouse] slow query ${ms}ms: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
    } else {
      console.log(`[clickhouse] ${ms}ms ${rows.length} rows`);
    }
    return rows;
  } catch (err) {
    if (isTransientMemoryError(err)) {
      console.warn(`[clickhouse] MEMORY_LIMIT_EXCEEDED — backing off and retrying once`);
      await sleep(1500);
      const rows = await exec();
      console.log(`[clickhouse] retry ok, ${rows.length} rows`);
      return rows;
    }
    throw err;
  }
}

export async function ping(): Promise<boolean> {
  try {
    const r = await client.ping();
    return r.success;
  } catch {
    return false;
  }
}
