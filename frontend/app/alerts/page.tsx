'use client';
import { useEffect, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, CheckCircle, Clock } from 'lucide-react';

interface Alert {
  id: string;
  alertType: string;
  severity: string;
  source: string;
  title: string;
  status: string;
  createAt: string;
}

const severityColor: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-700',
  HIGH: 'bg-orange-100 text-orange-700',
  MEDIUM: 'bg-yellow-100 text-yellow-700',
  LOW: 'bg-green-100 text-green-700',
};

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios
      .get(process.env.NEXT_PUBLIC_API_URL + '/alerts')
      .then((r) => setAlerts(r.data))
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false));
  }, []);

  const resolve = async (id: string) => {
    await axios.patch(process.env.NEXT_PUBLIC_API_URL + '/alerts/' + id + '/resolve');
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: 'RESOLVED' } : a)),
    );
  };

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <AlertTriangle className="text-orange-500" /> Alert Viewer
      </h1>
      {loading ? (
        <p className="text-gray-400">Loading...</p>
      ) : alerts.length === 0 ? (
        <p className="text-gray-400">No alerts found.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {alerts.map((a) => (
            <div key={a.id} className="border rounded-xl p-4 flex items-center justify-between shadow-sm">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (severityColor[a.severity] ?? 'bg-gray-100 text-gray-600')}>
                    {a.severity}
                  </span>
                  <span className="text-xs text-gray-400">{a.source}</span>
                </div>
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-gray-400 flex items-center gap-1 mt-1">
                  <Clock size={12} /> {new Date(a.createAt).toLocaleString()}
                </p>
              </div>
              {a.status === 'OPEN' ? (
                <button
                  onClick={() => resolve(a.id)}
                  className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700"
                >
                  Resolve
                </button>
              ) : (
                <span className="flex items-center gap-1 text-green-600 text-sm">
                  <CheckCircle size={16} /> Resolved
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}