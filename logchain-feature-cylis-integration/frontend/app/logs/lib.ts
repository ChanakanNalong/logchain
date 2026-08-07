import type { LogRow } from '@/components/LogTable';

export interface RawLog {
  id?: string;
  createdAt?: string;
  source?: string;
  sourceIp?: string;
  message?: string;
  eventType?: string;
  severity?: string;
}

export function toTone(sev: string): LogRow['sev'] {
  const s = (sev ?? '').toUpperCase();
  if (s === 'CRITICAL' || s === 'HIGH') return 'danger';
  if (s === 'WARNING' || s === 'MEDIUM') return 'warn';
  return 'good';
}

export function mapLog(l: RawLog): LogRow {
  return {
    id: l.id?.slice(0, 8) ?? '—',
    ts: l.createdAt ? new Date(l.createdAt).toLocaleString('sv-SE') : '—',
    source: l.source ?? '—',
    ip: l.sourceIp ?? '—',
    event: l.message ?? '—',
    attackType: l.eventType ?? '—',
    sev: toTone(l.severity ?? ''),
  };
}
