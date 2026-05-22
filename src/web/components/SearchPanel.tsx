import { useCallback, useEffect, useRef, useState } from 'react';
import { Container, Table, TextField, Title, Text } from '@clickhouse/click-ui';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  search,
  searchTimeline,
  type SearchBucketPoint,
  type SearchResult,
  type SearchTimelineResponse,
  type YearScope,
} from '../api';
import { recordAction } from '../telemetry';
import { CHART_TICK, CHART_TOOLTIP_CONTENT_STYLE, COLORS, INTER_FAMILY } from '../theme';

const NUMBER = new Intl.NumberFormat('en');
const DEBOUNCE_MS = 350;
const MONTH_LABEL = new Intl.DateTimeFormat('en', { month: 'short' });
const MONTH_YEAR_LABEL = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });

// Inline style so the brand-yellow link color survives no matter what global
// link styles the dark theme inherits from the browser.
const LINK_STYLE: React.CSSProperties = {
  color: COLORS.primary,
  textDecoration: 'none',
  fontWeight: 500,
};

function formatPostedAt(iso: string): string {
  if (!iso) return '';
  // ClickHouse DateTime comes back as "YYYY-MM-DD HH:MM:SS"; new Date() needs
  // a "T" separator (or an offset) to be standards-compliant across browsers.
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return MONTH_YEAR_LABEL.format(d);
}

function bucketLabel(bucket: string, granularity: 'year' | 'month'): string {
  if (granularity === 'year') return bucket;
  const d = new Date(bucket);
  return Number.isNaN(d.getTime()) ? bucket : MONTH_LABEL.format(d);
}

interface Props {
  year: YearScope;
  scopeLabel: string;
}

export function SearchPanel({ year, scopeLabel }: Props) {
  const [q, setQ] = useState('clickhouse');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [timeline, setTimeline] = useState<SearchTimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    async (term: string, scope: YearScope) => {
      if (term.trim().length < 2) {
        setResults([]);
        setTimeline(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [r, t] = await Promise.all([search(term, scope), searchTimeline(term, scope)]);
        setResults(r);
        setTimeline(t);
        recordAction('Search-Submitted', { q: term, year: scope ?? 'all', hits: r.length });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void runSearch(q, year);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [q, year, runSearch]);

  const titleSuffix = year !== null ? ` · ${scopeLabel}` : '';
  const granularity: 'year' | 'month' = timeline?.granularity ?? (year === null ? 'year' : 'month');

  const chartData = (timeline?.points ?? []).map((p: SearchBucketPoint) => ({
    ...p,
    label: bucketLabel(p.bucket, granularity),
  }));

  const headers = [
    { label: 'Title', width: '55%' },
    { label: 'Author' },
    { label: 'Score' },
    { label: 'Posted' },
  ];

  const rows = results.map((r) => ({
    id: r.id,
    items: [
      {
        label: r.url ? (
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            style={LINK_STYLE}
            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
          >
            {r.title || '(untitled)'}
          </a>
        ) : (
          r.title || '(untitled)'
        ),
      },
      { label: r.by },
      { label: NUMBER.format(r.score) },
      { label: formatPostedAt(r.time) },
    ],
  }));

  return (
    <Container orientation="vertical" gap="md" fillWidth>
      <Container orientation="horizontal" gap="sm" alignItems="end" justifyContent="space-between">
        <Title type="h2" size="md">
          Search stories{titleSuffix}
        </Title>
        <Text size="sm">
          {granularity === 'year' ? 'mentions per year' : 'mentions per month'}
        </Text>
      </Container>
      <TextField
        id="hn-search"
        label={`Search HackerNews story titles${titleSuffix}`}
        value={q}
        onChange={(v) => setQ(v)}
        placeholder="Try: clickhouse, rust, openai, kubernetes…"
        clear
        loading={loading}
      />
      {error && <Text size="sm">Error: {error}</Text>}
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey="label" tick={CHART_TICK} />
            <YAxis tick={CHART_TICK} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={{ fontFamily: INTER_FAMILY }}
              itemStyle={{ fontFamily: INTER_FAMILY }}
              cursor={{ fill: 'rgba(250, 255, 105, 0.08)' }}
            />
            <Bar dataKey="mentions" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Table headers={headers} rows={rows} noDataMessage="No matches yet — try another term." />
    </Container>
  );
}
