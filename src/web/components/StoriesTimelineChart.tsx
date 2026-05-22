import { Container, Title, Text } from '@clickhouse/click-ui';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TimelineResponse } from '../api';
import { CHART_TICK, CHART_TOOLTIP_CONTENT_STYLE, COLORS, INTER_FAMILY } from '../theme';

interface Props {
  data: TimelineResponse | null;
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const MONTH_LABEL = new Intl.DateTimeFormat('en', { month: 'short' });

function bucketLabel(bucket: string, granularity: 'year' | 'month'): string {
  if (granularity === 'year') return bucket;
  // Monthly buckets come as ISO date strings like "2024-01-01". Display as
  // short month names ("Jan", "Feb", ...) since the year is already in the
  // chart title.
  const d = new Date(bucket);
  return Number.isNaN(d.getTime()) ? bucket : MONTH_LABEL.format(d);
}

export function StoriesTimelineChart({ data }: Props) {
  const points = data?.points ?? [];
  const granularity = data?.granularity ?? 'year';
  const subtitle = data
    ? data.year !== null
      ? `Monthly · ${points.length} buckets`
      : `Yearly · ${points.length} buckets`
    : 'loading...';

  const labelled = points.map((p) => ({ ...p, label: bucketLabel(p.bucket, granularity) }));

  return (
    <Container orientation="vertical" gap="sm" fillWidth>
      <Container orientation="horizontal" gap="sm" alignItems="end" justifyContent="space-between">
        <Title type="h2" size="md">
          Activity over time
        </Title>
        <Text size="sm">{subtitle}</Text>
      </Container>
      <div style={{ width: '100%', height: 360 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={labelled} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gStories" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.primary} stopOpacity={0.85} />
                <stop offset="100%" stopColor={COLORS.primary} stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="gComments" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.secondary} stopOpacity={0.5} />
                <stop offset="100%" stopColor={COLORS.secondary} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey="label" tick={CHART_TICK} minTickGap={20} />
            <YAxis tick={CHART_TICK} tickFormatter={(v) => COMPACT.format(v as number)} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={{ fontFamily: INTER_FAMILY }}
              itemStyle={{ fontFamily: INTER_FAMILY }}
              formatter={(value) => COMPACT.format(Number(value))}
            />
            <Legend wrapperStyle={{ fontSize: 12, fontFamily: INTER_FAMILY }} />
            <Area
              type="monotone"
              dataKey="stories"
              stroke={COLORS.primary}
              fill="url(#gStories)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="comments"
              stroke={COLORS.secondary}
              fill="url(#gComments)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Container>
  );
}
