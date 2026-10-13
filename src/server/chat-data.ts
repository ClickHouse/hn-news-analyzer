export type ChatKind = 'stories' | 'trend' | 'authors' | 'domains' | 'summary' | 'unsupported';
export interface ChatPlan {
  kind: ChatKind;
  topic: string;
  fromDate: string | null;
  toDate: string | null;
  sort: 'score' | 'comments' | 'recent';
  limit: number;
}
export interface ChatColumn {
  key: string;
  label: string;
  format?: 'number' | 'story' | 'date';
}
export interface ChatData {
  columns: ChatColumn[];
  rows: Record<string, unknown>[];
}

const KINDS = new Set(['stories', 'trend', 'authors', 'domains', 'summary', 'unsupported']);
const SORTS = new Set(['score', 'comments', 'recent']);

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value &&
    value >= '2006-01-01';
}

// Model output is a small query plan, never executable SQL.
export function parseChatPlan(value: unknown, year: number | null): ChatPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid query plan');
  const p = value as Record<string, unknown>;
  if (!KINDS.has(String(p.kind)) || typeof p.topic !== 'string' || p.topic.length > 100 ||
      !SORTS.has(String(p.sort)) || !Number.isInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 20) {
    throw new Error('Invalid query plan');
  }
  let fromDate = p.fromDate;
  let toDate = p.toDate;
  if (fromDate === null && toDate === null) {
    fromDate = year === null ? '2006-01-01' : `${year}-01-01`;
    toDate = year === null ? null : `${year + 1}-01-01`;
  }
  if (!validDate(fromDate) || (toDate !== null && !validDate(toDate)) ||
      (typeof toDate === 'string' && toDate <= fromDate)) throw new Error('Invalid query dates');
  return {
    kind: p.kind as ChatKind, topic: p.topic.trim(), fromDate,
    toDate: toDate as string | null, sort: p.sort as ChatPlan['sort'], limit: Number(p.limit),
  };
}

export function buildChatQuery(plan: ChatPlan) {
  const filters = ["type = 'story'", 'deleted = 0', 'dead = 0', 'time >= {fromDate:DateTime}'];
  const params: Record<string, unknown> = { fromDate: plan.fromDate, limit: plan.limit };
  if (plan.toDate) {
    filters.push('time < {toDate:DateTime}');
    params.toDate = plan.toDate;
  }
  if (plan.topic) {
    filters.push('positionCaseInsensitive(title, {topic:String}) > 0');
    params.topic = plan.topic;
  }
  const where = filters.join(' AND ');
  let sql: string;
  let columns: ChatColumn[];
  switch (plan.kind) {
    case 'stories': {
      const order = { score: 'score DESC, id DESC', comments: 'descendants DESC, id DESC', recent: 'time DESC, id DESC' }[plan.sort];
      sql = `SELECT id, title, by AS author, score, descendants AS comments, toString(time) AS posted
        FROM hackernews.hackernews WHERE ${where} ORDER BY ${order} LIMIT {limit:UInt8}`;
      columns = [
        { key: 'title', label: 'Story', format: 'story' }, { key: 'author', label: 'Author' },
        { key: 'score', label: 'Points', format: 'number' }, { key: 'comments', label: 'Comments', format: 'number' },
        { key: 'posted', label: 'Posted', format: 'date' },
      ];
      break;
    }
    case 'trend': {
      const months = plan.toDate && Date.parse(plan.toDate) - Date.parse(plan.fromDate!) <= 366 * 86_400_000;
      const bucket = months ? 'toString(toStartOfMonth(time))' : 'toString(toYear(time))';
      sql = `SELECT ${bucket} AS period, count() AS stories FROM hackernews.hackernews
        WHERE ${where} GROUP BY period ORDER BY period LIMIT 100`;
      columns = [{ key: 'period', label: months ? 'Month' : 'Year' }, { key: 'stories', label: 'Stories', format: 'number' }];
      break;
    }
    case 'authors':
    case 'domains': {
      const dimension = plan.kind === 'authors' ? 'by' : 'domain(url)';
      const nonempty = plan.kind === 'authors' ? "by != ''" : "url != '' AND domain(url) != ''";
      sql = `SELECT ${dimension} AS name, count() AS stories, sum(score) AS points
        FROM hackernews.hackernews WHERE ${where} AND ${nonempty}
        GROUP BY name ORDER BY stories DESC, points DESC, name ASC LIMIT {limit:UInt8}`;
      columns = [{ key: 'name', label: plan.kind === 'authors' ? 'Author' : 'Domain' },
        { key: 'stories', label: 'Stories', format: 'number' }, { key: 'points', label: 'Points', format: 'number' }];
      break;
    }
    case 'summary':
      sql = `SELECT count() AS stories, sum(score) AS points, sum(greatest(descendants, 0)) AS comments
        FROM hackernews.hackernews WHERE ${where} LIMIT 1`;
      columns = [{ key: 'stories', label: 'Stories', format: 'number' },
        { key: 'points', label: 'Points', format: 'number' }, { key: 'comments', label: 'Comments', format: 'number' }];
      break;
    default:
      throw new Error('Unsupported question');
  }
  return { sql, params, columns };
}

export function describeScope(plan: ChatPlan): string {
  const topic = plan.topic ? `Titles containing “${plan.topic}”` : 'All story titles';
  const dates = plan.fromDate === '2006-01-01' && !plan.toDate ? 'all time' :
    `${plan.fromDate}${plan.toDate ? ` to ${new Date(Date.parse(plan.toDate) - 86_400_000).toISOString().slice(0, 10)}` : ' onward'}`;
  return `${topic} · ${dates}`;
}

export function describeResults(plan: ChatPlan, rows: Record<string, unknown>[]): string {
  if (rows.length === 0 || (plan.kind === 'summary' && Number(rows[0]?.stories) === 0)) {
    return 'No stories matched. Try a shorter topic or a different date range.';
  }
  const n = new Intl.NumberFormat('en');
  switch (plan.kind) {
    case 'stories': return `Here ${rows.length === 1 ? 'is 1 story' : `are ${rows.length} stories`}, ordered by ${
      { score: 'points', comments: 'comment count', recent: 'most recent' }[plan.sort]}.`;
    case 'authors': return `Here are the ${rows.length} most active authors by story count.`;
    case 'domains': return `Here are the ${rows.length} most submitted domains by story count.`;
    case 'trend': return 'Here is how the number of matching stories changed over time.';
    case 'summary': return `${n.format(Number(rows[0].stories))} stories matched, with ${n.format(Number(rows[0].points))} points and ${n.format(Number(rows[0].comments))} comments in the dataset.`;
    default: return '';
  }
}
