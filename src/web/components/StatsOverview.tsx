import { BigStat, Container } from '@clickhouse/click-ui';
import type { Overview } from '../api';

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat('en');

function formatBigNumber(n: number): string {
  if (n >= 1_000_000) return COMPACT.format(n);
  return FULL.format(n);
}

function formatYearFromDateString(s: string): string {
  if (!s) return '—';
  const match = /^(\d{4})/.exec(s);
  return match?.[1] ?? '—';
}

export function StatsOverview({ data }: { data: Overview | null }) {
  return (
    <Container orientation="horizontal" gap="lg" wrap="wrap" fillWidth>
      <BigStat
        title={data ? formatBigNumber(data.totalRows) : '—'}
        label="Total rows"
        size="lg"
      />
      <BigStat
        title={data ? formatBigNumber(data.totalStories) : '—'}
        label="Stories"
        size="lg"
      />
      <BigStat
        title={data ? formatBigNumber(data.totalComments) : '—'}
        label="Comments"
        size="lg"
      />
      <BigStat
        title={data ? formatBigNumber(data.uniqueAuthors) : '—'}
        label="Unique authors"
        size="lg"
      />
      <BigStat
        title={
          data
            ? `${formatYearFromDateString(data.oldest)}–${formatYearFromDateString(data.newest)}`
            : '—'
        }
        label="Span"
        size="lg"
      />
    </Container>
  );
}
