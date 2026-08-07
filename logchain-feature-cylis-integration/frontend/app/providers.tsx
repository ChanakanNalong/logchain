'use client';
import { useEffect, useState, useRef } from 'react';
import keycloak from '@/lib/keycloak';

export default function Providers({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    // keycloak.init() เรียกซ้ำไม่ได้ (throw) จึงต้อง guard ด้วย ref กันไว้เฉพาะส่วนนี้
    if (!initialized.current) {
      initialized.current = true;

      // DEV: ไม่ตั้ง onLoad เลย — keycloak-js จะไม่เช็ค session และไม่ redirect ไปไหนทั้งสิ้น
      // (แม้แต่ 'check-sso' ก็ redirect ทั้งหน้าไป Keycloak จริง ๆ ถ้าไม่ได้ตั้ง
      // silentCheckSsoRedirectUri ไว้ — ถ้า Keycloak ไม่รัน จะเจอ ERR_CONNECTION_REFUSED
      // ทั้งหน้าเลย ไม่ใช่แค่ error ใน JS ที่ catch ได้)
      // เมื่อพร้อมต่อ backend/Keycloak จริง ให้เปลี่ยนกลับเป็น onLoad: 'login-required'
      keycloak
        .init({ pkceMethod: 'S256', checkLoginIframe: false })
        .catch((err) => console.warn('Keycloak unavailable, continuing without auth:', err))
        .finally(() => setReady(true));
    }

    // กันเผื่อ init() ค้าง (เช่น Keycloak server ไม่ตอบสนอง) ไม่ให้หน้าจอค้างตลอดไป
    // ตั้ง timer ใหม่ทุกครั้งที่ effect รัน (ไม่ผูกกับ ref guard ด้านบน) เพราะ
    // React StrictMode ใน dev รัน effect สองรอบ (setup->cleanup->setup) — ถ้า guard
    // ไว้ด้วยกัน timer ของรอบแรกจะถูก clear ทิ้งแล้วไม่มีรอบสองมาตั้งใหม่ จอเลยค้าง
    const fallback = setTimeout(() => setReady(true), 3000);
    return () => clearTimeout(fallback);
  }, []);

  if (!ready) return <p className="p-6 text-gray-400">Loading...</p>;
  return <>{children}</>;
}
