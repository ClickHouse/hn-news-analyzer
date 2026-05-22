import { Container, Table, Title } from '@clickhouse/click-ui';
import type { TopUser } from '../api';

const NUMBER = new Intl.NumberFormat('en');

interface Props {
  users: TopUser[];
  scopeLabel: string;
}

export function TopUsersTable({ users, scopeLabel }: Props) {
  const headers = [
    { label: 'User', width: '45%' },
    { label: 'Stories' },
    { label: 'Karma' },
  ];

  const rows = users.map((u, i) => ({
    id: `${u.user}-${i}`,
    items: [
      { label: <strong>{u.user || '(empty)'}</strong> },
      { label: NUMBER.format(u.stories) },
      { label: NUMBER.format(u.totalScore) },
    ],
  }));

  return (
    <Container orientation="vertical" gap="sm" fillWidth>
      <Title type="h2" size="md">
        Top users by karma · {scopeLabel}
      </Title>
      <Table headers={headers} rows={rows} noDataMessage="Loading..." />
    </Container>
  );
}
