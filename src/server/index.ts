/**
 * HackerNews Analyzer API + static file server.
 *
 * This file intentionally contains NO OpenTelemetry or HyperDX imports.
 * In the "before" demo state it runs plain; in the "after" state it's
 * wrapped by `opentelemetry-instrument` which patches express / http /
 * undici / console at process start. Identical source, different runner.
 *
 * The headline of the demo trace is the auto-instrumented HTTP span for
 * each outgoing call to sql-clickhouse.clickhouse.com, captured for free
 * because the @clickhouse/client uses Node's http stack under the hood.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';

import { query, ping, CLICKHOUSE_URL, CLICKHOUSE_DATABASE } from './clickhouse';

const PORT = Number(process.env.PORT ?? 5001);
const WEB_DIR = path.resolve(__dirname, '../web');

// ---------------------------------------------------------------------------
// Tiny TTL cache for dashboard endpoints.
//
// This is itself a demo prop: a cache HIT produces a trace with no
// ClickHouse child span; a MISS includes the POST to sql-clickhouse.* .
// The SA can point at two adjacent traces and say "look — OTel just made
// our cache effectiveness visible without a line of code".
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  stale: boolean;
}

const cache = new Map<string, CacheEntry<unknown>>();
// Longer TTL than feels "fresh" because the public demo cluster has noisy
// neighbours; this keeps our query rate down and improves stability.
const DEFAULT_TTL_MS = 30_000;
// We'll keep serving expired entries up to this age if ClickHouse errors.
const STALE_MAX_AGE_MS = 10 * 60_000;

async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<{ value: T; stale: boolean }> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    console.log(`[cache] hit  ${key}`);
    return { value: hit.value, stale: false };
  }
  try {
    console.log(`[cache] miss ${key}`);
    const value = await loader();
    cache.set(key, { value, expiresAt: now + ttlMs, stale: false });
    return { value, stale: false };
  } catch (err) {
    // Stale-while-error: if a query fails (e.g. cluster memory pressure)
    // and we have a not-too-old cached value, return it with a stale flag
    // rather than 500ing the dashboard.
    if (hit && now - hit.expiresAt < STALE_MAX_AGE_MS) {
      console.warn(
        `[cache] serving STALE ${key} (age ${Math.round(
          (now - hit.expiresAt) / 1000,
        )}s past TTL) — upstream: ${(err as Error).message.slice(0, 100)}`,
      );
      return { value: hit.value, stale: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Query handlers
// ---------------------------------------------------------------------------

// Year scoping. `null` means "all time".
type YearScope = number | null;

function yearFilterSql(year: YearScope): string {
  return year !== null ? 'AND toYear(time) = {year:UInt16}' : '';
}

function yearParams(year: YearScope): Record<string, unknown> {
  return year !== null ? { year } : {};
}

interface OverviewRow {
  total_rows: string;
  total_stories: string;
  total_comments: string;
  unique_authors: string;
  oldest: string;
  newest: string;
}

async function loadOverview(year: YearScope): Promise<OverviewRow> {
  const rows = await query<OverviewRow>(
    `
    SELECT
      count() AS total_rows,
      countIf(type = 'story') AS total_stories,
      countIf(type = 'comment') AS total_comments,
      -- uniq() uses HyperLogLog; constant memory and ~1% error, vs
      -- uniqExact which loads ~1.1M distinct strings into a hash set
      -- (gets killed by the public cluster's OvercommitTracker under load).
      uniq(by) AS unique_authors,
      toString(minIf(time, time > '2005-01-01')) AS oldest,
      toString(max(time)) AS newest
    FROM hackernews.hackernews
    WHERE 1 = 1 ${yearFilterSql(year)}
    `,
    yearParams(year),
  );
  return (
    rows[0] ?? {
      total_rows: '0',
      total_stories: '0',
      total_comments: '0',
      unique_authors: '0',
      oldest: '',
      newest: '',
    }
  );
}

interface TimelinePoint {
  bucket: string;
  stories: string;
  comments: string;
}

async function loadTimeline(year: YearScope): Promise<TimelinePoint[]> {
  if (year === null) {
    // All-time view: one bucket per year.
    return query<TimelinePoint>(`
      SELECT
        toString(toYear(time)) AS bucket,
        countIf(type = 'story')   AS stories,
        countIf(type = 'comment') AS comments
      FROM hackernews.hackernews
      WHERE time > '2005-01-01'
      GROUP BY bucket
      ORDER BY bucket
    `);
  }
  // Year selected: monthly buckets within that year.
  return query<TimelinePoint>(
    `
    SELECT
      toString(toStartOfMonth(time)) AS bucket,
      countIf(type = 'story')   AS stories,
      countIf(type = 'comment') AS comments
    FROM hackernews.hackernews
    WHERE toYear(time) = {year:UInt16}
    GROUP BY bucket
    ORDER BY bucket
    `,
    { year },
  );
}

interface TopUserRow {
  user: string;
  stories: string;
  total_score: string;
}

async function loadTopUsers(limit: number, year: YearScope): Promise<TopUserRow[]> {
  // When scoped to a year, the year filter alone is enough — the input is
  // already ~3-6M rows and tens of thousands of unique authors.
  // For all-time, also apply score>=50 to keep the GROUP BY hash table small
  // (top users by karma all have many high-scoring stories anyway).
  const scoreFilter = year === null ? 'AND score >= 50' : '';
  return query<TopUserRow>(
    `
    SELECT
      by AS user,
      count() AS stories,
      sum(score) AS total_score
    FROM hackernews.hackernews
    WHERE type = 'story' AND by != ''
      ${scoreFilter}
      ${yearFilterSql(year)}
    GROUP BY by
    ORDER BY total_score DESC
    LIMIT {limit:UInt8}
    `,
    { limit, ...yearParams(year) },
  );
}

interface TopDomainRow {
  host: string;
  stories: string;
  total_score: string;
}

async function loadTopDomains(limit: number, year: YearScope): Promise<TopDomainRow[]> {
  // See loadTopUsers — score filter only needed for all-time.
  const scoreFilter = year === null ? 'AND score >= 10' : '';
  return query<TopDomainRow>(
    `
    SELECT
      domain(url) AS host,
      count() AS stories,
      sum(score) AS total_score
    FROM hackernews.hackernews
    WHERE type = 'story' AND url != ''
      ${scoreFilter}
      ${yearFilterSql(year)}
    GROUP BY host
    HAVING host != ''
    ORDER BY stories DESC
    LIMIT {limit:UInt8}
    `,
    { limit, ...yearParams(year) },
  );
}

interface SearchRow {
  id: number;
  title: string;
  by: string;
  score: number;
  time: string;
  url: string;
}

async function loadSearch(q: string, limit: number, year: YearScope): Promise<SearchRow[]> {
  // IMPORTANT: do NOT alias selected columns back to their original names
  // (e.g. `toString(score) AS score`). ClickHouse resolves WHERE/ORDER BY
  // column references against SELECT aliases when names collide — so the
  // String alias `score` ended up sorted *lexicographically* (97 > 9 > 84),
  // and the alias `time` made `toYear(time)` in WHERE blow up with
  // "Illegal type String". JSONEachRow already serializes UInt32/Int32 as
  // JS numbers and DateTime as an ISO-ish string, so we just let columns
  // come through with their natural names and types.
  return query<SearchRow>(
    `
    SELECT id, title, by, score, time, url
    FROM hackernews.hackernews
    WHERE type = 'story'
      AND positionCaseInsensitive(title, {q:String}) > 0
      ${yearFilterSql(year)}
    ORDER BY score DESC
    LIMIT {limit:UInt8}
    SETTINGS optimize_read_in_order = 1
    `,
    { q, limit, ...yearParams(year) },
  );
}

interface SearchBucketRow {
  bucket: string;
  mentions: string;
}

async function loadSearchTimeline(q: string, year: YearScope): Promise<SearchBucketRow[]> {
  if (year === null) {
    // All-time: one bar per year of HN history.
    return query<SearchBucketRow>(
      `
      SELECT
        toString(toYear(time)) AS bucket,
        count() AS mentions
      FROM hackernews.hackernews
      WHERE type = 'story'
        AND positionCaseInsensitive(title, {q:String}) > 0
      GROUP BY bucket
      ORDER BY bucket
      `,
      { q },
    );
  }
  // Year selected: one bar per month within that year.
  return query<SearchBucketRow>(
    `
    SELECT
      toString(toStartOfMonth(time)) AS bucket,
      count() AS mentions
    FROM hackernews.hackernews
    WHERE type = 'story'
      AND toYear(time) = {year:UInt16}
      AND positionCaseInsensitive(title, {q:String}) > 0
    GROUP BY bucket
    ORDER BY bucket
    `,
    { q, year },
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.get('/api/health', async (_req: Request, res: Response) => {
  const ok = await ping();
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'clickhouse-unreachable',
    service: 'hn-analyzer-api',
    clickhouseUrl: CLICKHOUSE_URL,
    database: CLICKHOUSE_DATABASE,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get('/api/stats/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = parseYear(req.query.year);
    const { value, stale } = await cached(`overview:${year ?? 'all'}`, DEFAULT_TTL_MS, () =>
      loadOverview(year),
    );
    res.json({ ...value, year, stale });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats/timeline', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = parseYear(req.query.year);
    const { value, stale } = await cached(`timeline:${year ?? 'all'}`, DEFAULT_TTL_MS, () =>
      loadTimeline(year),
    );
    res.json({ year, granularity: year === null ? 'year' : 'month', points: value, stale });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats/top-users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = clampInt(req.query.limit, 1, 50, 10);
    const year = parseYear(req.query.year);
    const { value, stale } = await cached(
      `top-users:${year ?? 'all'}:${limit}`,
      DEFAULT_TTL_MS,
      () => loadTopUsers(limit, year),
    );
    res.json({ year, users: value, stale });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats/top-domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = clampInt(req.query.limit, 1, 50, 10);
    const year = parseYear(req.query.year);
    const { value, stale } = await cached(
      `top-domains:${year ?? 'all'}:${limit}`,
      DEFAULT_TTL_MS,
      () => loadTopDomains(limit, year),
    );
    res.json({ year, domains: value, stale });
  } catch (err) {
    next(err);
  }
});

app.get('/api/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const year = parseYear(req.query.year);
    if (q.length < 2) {
      res.json({ q, year, results: [] });
      return;
    }
    const limit = clampInt(req.query.limit, 1, 50, 20);
    const results = await loadSearch(q, limit, year);
    res.json({ q, year, results });
  } catch (err) {
    next(err);
  }
});

app.get('/api/search/timeline', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const year = parseYear(req.query.year);
    if (q.length < 2) {
      res.json({ q, year, granularity: year === null ? 'year' : 'month', points: [] });
      return;
    }
    const points = await loadSearchTimeline(q, year);
    res.json({ q, year, granularity: year === null ? 'year' : 'month', points });
  } catch (err) {
    next(err);
  }
});

// Static frontend — built by `vite build` into dist/web.
app.use(express.static(WEB_DIR));
app.get(/^\/(?!api).*/, (_req: Request, res: Response) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

// Centralized error handler. console.error → captured as a log record by
// the OTel logging instrumentation when running in instrumented mode.
app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  console.error(`[error] ${req.method} ${req.path} → ${err.name}: ${err.message}`);
  res.status(status).json({ error: err.name, message: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`=== HN ANALYZER on http://localhost:${PORT} ===`);
  console.log(`[clickhouse] data source: ${CLICKHOUSE_URL} / db=${CLICKHOUSE_DATABASE}`);
  console.log(
    `[telemetry] OTLP endpoint configured: ${
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '(unset)'
    }  (whether the SDK is actually wired up depends on the run.sh toggle)`,
  );
  maybeStartSelfTraffic();
});

process.on('SIGINT', () => {
  console.log('\n[shutdown] SIGINT received');
  server.close(() => process.exit(0));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Parses ?year=2024. Anything missing or non-numeric → null (= "all time").
// Constrained to a sensible window so we don't fan out cache keys infinitely.
function parseYear(raw: unknown): YearScope {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const y = Math.floor(n);
  if (y < 2006 || y > 2030) return null;
  return y;
}

// ---------------------------------------------------------------------------
// Optional fallback self-traffic loop (SELF_TRAFFIC=1). Off by default —
// the React UI is the primary traffic source.
// ---------------------------------------------------------------------------

const SEARCH_TERMS = [
  'rust',
  'python',
  'openai',
  'bitcoin',
  'linux',
  'show hn',
  'startup',
  'database',
  'kubernetes',
  'react',
  'security',
  'compiler',
];

function maybeStartSelfTraffic(): void {
  if (process.env.SELF_TRAFFIC !== '1') return;
  const baseUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[traffic] self-traffic loop enabled → ${baseUrl}`);

  const yearQs = () => {
    // 30% all-time, 70% a random recent year — keeps cache warm across years.
    if (Math.random() < 0.3) return '';
    const y = 2015 + Math.floor(Math.random() * 12); // 2015..2026
    return `year=${y}`;
  };
  const join = (...parts: string[]) => {
    const qs = parts.filter(Boolean).join('&');
    return qs ? `?${qs}` : '';
  };

  const actions = [
    () => fetch(`${baseUrl}/api/stats/overview${join(yearQs())}`),
    () => fetch(`${baseUrl}/api/stats/timeline${join(yearQs())}`),
    () => fetch(`${baseUrl}/api/stats/top-users${join(yearQs(), 'limit=10')}`),
    () => fetch(`${baseUrl}/api/stats/top-domains${join(yearQs(), 'limit=10')}`),
    () => {
      const q = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
      return fetch(`${baseUrl}/api/search${join(`q=${encodeURIComponent(q!)}`, yearQs())}`);
    },
  ];

  const tick = async () => {
    const action = actions[Math.floor(Math.random() * actions.length)]!;
    try {
      const r = await action();
      console.log(`[traffic] → ${r.status}`);
    } catch (err) {
      console.error(`[traffic] error: ${(err as Error).message}`);
    } finally {
      setTimeout(tick, 2000 + Math.floor(Math.random() * 1000));
    }
  };
  setTimeout(tick, 2500);
}
