'use client';

import { useMemo, useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useTheme } from '@/lib/theme-context';
import { Card, SectionLabel } from '@/components/ui';
import LogTable, { type LogRow } from '@/components/LogTable';
import api from '@/lib/axios';
import { mapLog, type RawLog } from './lib';
import AttackTypeFilter from './_components/AttackTypeFilter';

export default function LogsPage() {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [attackType, setAttackType] = useState('All types');
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/logs')
      .then((r) => {
        const rows: RawLog[] = Array.isArray(r.data) ? r.data : (r.data?.data ?? []);
        setLogs(rows.map(mapLog));
      })
      .catch((e) => {
        console.error('logs fetch failed', e);
        setLogs([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const attackTypes = useMemo(
    () => ['All types', ...Array.from(new Set(logs.map((l) => l.attackType)))],
    [logs],
  );

  const filtered = useMemo(
    () =>
      logs.filter((log) => {
        const matchesQuery = [log.id, log.source, log.ip, log.event, log.attackType]
          .join(' ').toLowerCase().includes(query.toLowerCase());
        const matchesType = attackType === 'All types' || log.attackType === attackType;
        return matchesQuery && matchesType;
      }),
    [logs, query, attackType],
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card>
        <SectionLabel>Search logs</SectionLabel>
        <div style={{ position: 'relative', marginTop: 8 }}>
          <Search size={15} color={t.muted} style={{ position: 'absolute', left: 12, top: 11 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ID, source, IP, event, or type…"
            style={{
              width: '100%', background: t.surface2, border: `1px solid ${t.border}`,
              borderRadius: 10, padding: '10px 12px 10px 36px', color: t.text,
              fontSize: 13, outline: 'none',
            }}
          />
        </div>
      </Card>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <SectionLabel>All logs ({filtered.length})</SectionLabel>
          <AttackTypeFilter value={attackType} onChange={setAttackType} options={attackTypes} />
        </div>
        {loading ? (
          <div style={{ color: t.muted, padding: 20, textAlign: 'center' }}>Loading…</div>
        ) : logs.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: 'center' }}>No logs found</div>
        ) : (
          <LogTable logs={filtered} />
        )}
      </Card>
    </div>
  );
}
