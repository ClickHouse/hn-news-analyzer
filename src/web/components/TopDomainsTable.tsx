import { Container, Table, Title } from '@clickhouse/click-ui';
import type { TopDomain } from '../api';

const NUMBER = new Intl.NumberFormat('en');

interface Props {
  domains: TopDomain[];
  scopeLabel: string;
}

export function TopDomainsTable({ domains, scopeLabel }: Props) {
  const headers = [
    { label: 'Domain', width: '45%' },
    { label: 'Stories' },
    { label: 'Total score' },
  ];

  const rows = domains.map((d, i) => ({
    id: `${d.host}-${i}`,
    items: [
      { label: <code>{d.host || '(empty)'}</code> },
      { label: NUMBER.format(d.stories) },
      { label: NUMBER.format(d.totalScore) },
    ],
  }));

  return (
    <Container orientation="vertical" gap="sm" fillWidth>
      <Title type="h2" size="md">
        Top story domains · {scopeLabel}
      </Title>
      <Table headers={headers} rows={rows} noDataMessage="Loading..." />
    </Container>
  );
}
