// Shared brand palette so every chart, link, and accent stays in sync.
// Numbers come from the public ClickHouse design system (clickhouse.design),
// with the electric-yellow primary used as the sole accent on dark surfaces.

export const COLORS = {
  primary: '#faff69',
  primaryActive: '#e6eb52',
  primarySoft: 'rgba(250, 255, 105, 0.65)',
  secondary: '#cccccc',
  secondarySoft: 'rgba(204, 204, 204, 0.55)',
  surfaceCard: '#1a1a1a',
  hairlineStrong: '#3a3a3a',
  muted: '#888888',
  ink: '#ffffff',
} as const;

export const INTER_FAMILY =
  '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const CHART_TICK = {
  fontSize: 11,
  fontFamily: INTER_FAMILY,
  fill: COLORS.muted,
} as const;

export const CHART_TOOLTIP_CONTENT_STYLE = {
  background: COLORS.surfaceCard,
  border: `1px solid ${COLORS.hairlineStrong}`,
  borderRadius: 6,
  fontSize: 12,
  fontFamily: INTER_FAMILY,
} as const;
