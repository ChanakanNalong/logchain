'use client';

import { useTheme } from '@/lib/theme-context';
import { monoFont } from '@/lib/theme';
import { Th, Td, Badge, type BadgeTone } from './ui';

export interface LogRow {
  id: string;
  ts: string;
  source: string;
  ip: string;
  event: string;
  attackType: string;
  sev: BadgeTone;
}

export default function LogTable({ logs }: { logs: LogRow[] }) {
  const t = useTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {['ID', 'Timestamp', 'Source', 'IP', 'Event', 'Attack Type', 'Severity'].map((h) => (
              <Th key={h}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {logs.map((r) => (
            <tr key={r.id}>
              <Td style={{ color: t.blue2, ...monoFont }}>{r.id}</Td>
              <Td style={{ color: t.muted, ...monoFont }}>{r.ts}</Td>
              <Td>{r.source}</Td>
              <Td style={{ ...monoFont }}>{r.ip}</Td>
              <Td>{r.event}</Td>
              <Td style={{ color: t.muted }}>{r.attackType}</Td>
              <Td>
                <Badge tone={r.sev}>
                  {r.sev === 'danger' ? 'high' : r.sev === 'warn' ? 'med' : 'low'}
                </Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
