import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  ClickUIProvider,
  Container,
  Panel,
  Select,
  Separator,
  Text,
  Title,
} from '@clickhouse/click-ui';
import {
  fetchOverview,
  fetchTimeline,
  fetchTopDomains,
  fetchTopUsers,
  type Overview,
  type TimelineResponse,
  type TopDomain,
  type TopUser,
  type YearScope,
} from './api';
import { recordAction } from './telemetry';
import { StatsOverview } from './components/StatsOverview';
import { StoriesTimelineChart } from './components/StoriesTimelineChart';
import { TopUsersTable } from './components/TopUsersTable';
import { TopDomainsTable } from './components/TopDomainsTable';
import { SearchPanel } from './components/SearchPanel';

const DASHBOARD_REFRESH_MS = 15_000;
const CURRENT_YEAR = new Date().getFullYear();
const EARLIEST_YEAR = 2006;

const YEAR_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All time' },
  ...Array.from({ length: CURRENT_YEAR - EARLIEST_YEAR + 1 }, (_, i) => {
    const y = CURRENT_YEAR - i;
    return { value: String(y), label: String(y) };
  }),
];

function parseYearValue(v: string): YearScope {
  if (v === 'all') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function App() {
  const [year, setYear] = useState<YearScope>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [topDomains, setTopDomains] = useState<TopDomain[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleCount, setStaleCount] = useState(0);

  const scopeLabel = year !== null ? String(year) : 'all time';

  const refreshAll = useCallback(async (scope: YearScope) => {
    try {
      const [o, t, u, d] = await Promise.all([
        fetchOverview(scope),
        fetchTimeline(scope),
        fetchTopUsers(scope, 10),
        fetchTopDomains(scope, 10),
      ]);
      setOverview(o);
      setTimeline(t);
      setTopUsers(u.users);
      setTopDomains(d.domains);
      setLastRefresh(new Date());
      setError(null);
      const stale = [o.stale, t.stale, u.stale, d.stale].filter(Boolean).length;
      setStaleCount(stale);
      recordAction('Dashboard-Refresh', { year: scope ?? 'all', stale });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshAll(year);
    const id = setInterval(() => {
      void refreshAll(year);
    }, DASHBOARD_REFRESH_MS);
    return () => clearInterval(id);
  }, [year, refreshAll]);

  const yearSelectValue = useMemo(() => (year !== null ? String(year) : 'all'), [year]);

  return (
    <ClickUIProvider theme="dark">
      <Container
        orientation="vertical"
        gap="lg"
        padding="lg"
        maxWidth="1400px"
        style={{ margin: '0 auto' }}
      >
        <Container
          orientation="horizontal"
          justifyContent="space-between"
          alignItems="center"
          fillWidth
          wrap="wrap"
          gap="md"
        >
          <Container orientation="vertical" gap="xs">
            <Title type="h1" size="lg">
              HackerNews on ClickHouse
            </Title>
            <Text size="sm">
              Live queries against <code>sql-clickhouse.clickhouse.com</code> /{' '}
              <code>hackernews.hackernews</code> · showing <strong>{scopeLabel}</strong>
            </Text>
          </Container>
          <Container orientation="horizontal" gap="sm" alignItems="center">
            <div style={{ minWidth: 160 }}>
              <Select
                id="year-scope"
                value={yearSelectValue}
                onSelect={(v) => setYear(parseYearValue(v))}
                options={YEAR_OPTIONS}
              />
            </div>
            {staleCount > 0 && (
              <Badge
                state="warning"
                text={`${staleCount} panel${staleCount === 1 ? '' : 's'} serving cached data`}
              />
            )}
          </Container>
        </Container>

        {error && (
          <Panel>
            <Text>Last refresh failed: {error}</Text>
          </Panel>
        )}

        <div style={{ width: '100%' }}>
          <Panel>
            <StatsOverview data={overview} />
          </Panel>
        </div>

        <div style={{ width: '100%' }}>
          <Panel>
            <StoriesTimelineChart data={timeline} />
          </Panel>
        </div>

        <Container orientation="horizontal" gap="lg" wrap="wrap" fillWidth>
          <div style={{ flex: '1 1 480px', minWidth: 0 }}>
            <Panel>
              <TopUsersTable users={topUsers} scopeLabel={scopeLabel} />
            </Panel>
          </div>
          <div style={{ flex: '1 1 480px', minWidth: 0 }}>
            <Panel>
              <TopDomainsTable domains={topDomains} scopeLabel={scopeLabel} />
            </Panel>
          </div>
        </Container>

        <div style={{ width: '100%' }}>
          <Panel>
            <SearchPanel year={year} scopeLabel={scopeLabel} />
          </Panel>
        </div>

        <Separator size="md" />
        <Text size="sm">
          {lastRefresh
            ? `Last refresh ${lastRefresh.toLocaleTimeString()} · auto-refreshes every ${
                DASHBOARD_REFRESH_MS / 1000
              }s`
            : 'Refreshing...'}
        </Text>
      </Container>
    </ClickUIProvider>
  );
}
