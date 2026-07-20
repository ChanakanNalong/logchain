'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/axios';
import { ShieldCheck, ShieldX, Clock } from 'lucide-react';

interface LogEntry {
  id: string;
  txHash: string;
  status: string;
  source: string;
  createdAt: string;
  verified: boolean;
}

export default function IntegrityPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/logs')
      .then((r) => setLogs(r.data))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <ShieldCheck className="text-blue-500" /> Log Integrity
      </h1>
      {loading ? (
        <p className="text-gray-400">Loading...</p>
      ) : logs.length === 0 ? (
        <p className="text-gray-400">No logs found.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {logs.map((log) => (
            <div key={log.id} className="border rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600">{log.source}</span>
                {log.verified ? (
                  <span className="flex items-center gap-1 text-green-600 text-sm">
                    <ShieldCheck size={16} /> Verified
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-red-500 text-sm">
                    <ShieldX size={16} /> Tampered
                  </span>
                )}
              </div>
              <p className="text-xs font-mono text-gray-400 truncate">tx: {log.txHash}</p>
              <p className="text-xs text-gray-400 flex items-center gap-1 mt-1">
                <Clock size={12} /> {new Date(log.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}