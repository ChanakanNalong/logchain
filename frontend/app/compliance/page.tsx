'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/axios';
import { FileText, Clock } from 'lucide-react';

interface Report {
  id: string;
  title: string;
  type: string;
  createdAt: string;
  summary: string;
}

export default function CompliancePage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/compliance/reports')
      .then((r) => setReports(r.data))
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <FileText className="text-purple-500" /> Compliance Reports
      </h1>
      {loading ? (
        <p className="text-gray-400">Loading...</p>
      ) : reports.length === 0 ? (
        <p className="text-gray-400">No reports found.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {reports.map((r) => (
            <div key={r.id} className="border rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">{r.title}</span>
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">{r.type}</span>
              </div>
              <p className="text-sm text-gray-500 mb-2">{r.summary}</p>
              <p className="text-xs text-gray-400 flex items-center gap-1">
                <Clock size={12} /> {new Date(r.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}