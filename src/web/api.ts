/**
 * Typed fetch wrappers for the backend's /api/* endpoints.
 *
 * ClickHouse returns numeric aggregates as strings via JSONEachRow, so the
 * raw row types use string and we coerce to number in the helpers below
 * (keeps the components free of `Number(...)` noise).
 */

export interface HealthResponse {
  status: string;
  service: string;
  clickhouseUrl: string;
  database: string;
  uptimeSec: number;
}

/** `null` means "all time". */
export type YearScope = number | null;

export interface Overview {
  year: YearScope;
  totalRows: number;
  totalStories: number;
  totalComments: number;
  uniqueAuthors: number;
  oldest: string;
  newest: string;
  stale: boolean;
}

export interface TimelinePoint {
  bucket: string;
  stories: number;
  comments: number;
}

export interface TimelineResponse {
  year: YearScope;
  granularity: 'year' | 'month';
  points: TimelinePoint[];
  stale: boolean;
}

export interface TopUser {
  user: string;
  stories: number;
  totalScore: number;
}

export interface TopDomain {
  host: string;
  stories: number;
  totalScore: number;
}

export interface SearchResult {
  id: string;
  title: string;
  by: string;
  score: number;
  time: string;
  url: string;
}

export interface SearchBucketPoint {
  /** ISO date "YYYY-MM-DD" when monthly, year "YYYY" when yearly. */
  bucket: string;
  mentions: number;
}

export interface SearchTimelineResponse {
  year: YearScope;
  granularity: 'year' | 'month';
  points: SearchBucketPoint[];
}

// ---------------------------------------------------------------------------

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body || '(empty body)'}`);
  }
  return (await res.json()) as T;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health');
}

function yearQs(year: YearScope, extras: Record<string, string | number> = {}): string {
  const parts: string[] = [];
  if (year !== null) parts.push(`year=${year}`);
  for (const [k, v] of Object.entries(extras)) parts.push(`${k}=${v}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function fetchOverview(year: YearScope = null): Promise<Overview> {
  const raw = await request<{
    year: YearScope;
    total_rows: string;
    total_stories: string;
    total_comments: string;
    unique_authors: string;
    oldest: string;
    newest: string;
    stale?: boolean;
  }>(`/api/stats/overview${yearQs(year)}`);
  return {
    year: raw.year ?? null,
    totalRows: num(raw.total_rows),
    totalStories: num(raw.total_stories),
    totalComments: num(raw.total_comments),
    uniqueAuthors: num(raw.unique_authors),
    oldest: raw.oldest,
    newest: raw.newest,
    stale: Boolean(raw.stale),
  };
}

export async function fetchTimeline(year: YearScope = null): Promise<TimelineResponse> {
  const raw = await request<{
    year: YearScope;
    granularity: 'year' | 'month';
    points: { bucket: string; stories: string; comments: string }[];
    stale?: boolean;
  }>(`/api/stats/timeline${yearQs(year)}`);
  return {
    year: raw.year ?? null,
    granularity: raw.granularity,
    points: raw.points.map((p) => ({
      bucket: p.bucket,
      stories: num(p.stories),
      comments: num(p.comments),
    })),
    stale: Boolean(raw.stale),
  };
}

export interface TopUsersResponse {
  year: YearScope;
  users: TopUser[];
  stale: boolean;
}

export async function fetchTopUsers(year: YearScope = null, limit = 10): Promise<TopUsersResponse> {
  const raw = await request<{
    year: YearScope;
    users: { user: string; stories: string; total_score: string }[];
    stale?: boolean;
  }>(`/api/stats/top-users${yearQs(year, { limit })}`);
  return {
    year: raw.year ?? null,
    users: raw.users.map((u) => ({
      user: u.user,
      stories: num(u.stories),
      totalScore: num(u.total_score),
    })),
    stale: Boolean(raw.stale),
  };
}

export interface TopDomainsResponse {
  year: YearScope;
  domains: TopDomain[];
  stale: boolean;
}

export async function fetchTopDomains(
  year: YearScope = null,
  limit = 10,
): Promise<TopDomainsResponse> {
  const raw = await request<{
    year: YearScope;
    domains: { host: string; stories: string; total_score: string }[];
    stale?: boolean;
  }>(`/api/stats/top-domains${yearQs(year, { limit })}`);
  return {
    year: raw.year ?? null,
    domains: raw.domains.map((d) => ({
      host: d.host,
      stories: num(d.stories),
      totalScore: num(d.total_score),
    })),
    stale: Boolean(raw.stale),
  };
}

export async function search(
  q: string,
  year: YearScope = null,
  limit = 20,
): Promise<SearchResult[]> {
  const raw = await request<{
    q: string;
    year: YearScope;
    results: {
      id: number | string;
      title: string;
      by: string;
      score: number | string;
      time: string;
      url: string;
    }[];
  }>(`/api/search?q=${encodeURIComponent(q)}${year !== null ? `&year=${year}` : ''}&limit=${limit}`);
  return raw.results.map((r) => ({
    id: String(r.id),
    title: r.title,
    by: r.by,
    score: num(r.score),
    time: r.time,
    url: r.url,
  }));
}

export async function searchTimeline(
  q: string,
  year: YearScope = null,
): Promise<SearchTimelineResponse> {
  const raw = await request<{
    q: string;
    year: YearScope;
    granularity: 'year' | 'month';
    points: { bucket: string; mentions: string }[];
  }>(`/api/search/timeline?q=${encodeURIComponent(q)}${year !== null ? `&year=${year}` : ''}`);
  return {
    year: raw.year ?? null,
    granularity: raw.granularity,
    points: raw.points.map((p) => ({ bucket: p.bucket, mentions: num(p.mentions) })),
  };
}
