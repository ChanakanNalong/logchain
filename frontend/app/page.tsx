import Link from 'next/link';

export default function Home() {
  return (
    <main className="p-6 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Logchain Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/alerts" className="border rounded-xl p-6 hover:bg-gray-50 transition">
          <h2 className="text-xl font-semibold mb-2">Alert Viewer</h2>
          <p className="text-gray-500 text-sm">ดู alert ทั้งหมด และ resolve</p>
        </Link>
        <Link href="/integrity" className="border rounded-xl p-6 hover:bg-gray-50 transition">
          <h2 className="text-xl font-semibold mb-2">Log Integrity</h2>
          <p className="text-gray-500 text-sm">ตรวจสอบความสมบูรณ์ของ log บน blockchain</p>
        </Link>
        <Link href="/compliance" className="border rounded-xl p-6 hover:bg-gray-50 transition">
          <h2 className="text-xl font-semibold mb-2">Compliance Reports</h2>
          <p className="text-gray-500 text-sm">รายงาน compliance ทั้งหมด</p>
        </Link>
      </div>
    </main>
  );
}