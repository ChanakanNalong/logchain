import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ยิง `fetchFn` ซ้ำตามรอบเพื่อ auto-refresh ข้อมูลของหน้า โดย:
 * - ดึงเฉพาะตอนแท็บ visible (`document.visibilityState === "visible"`) — แท็บถูกซ่อน = ข้ามรอบ ไม่ยิง
 * - พอกลับมาที่แท็บ ดึงทันที 1 ครั้งแล้วเริ่มนับรอบใหม่ (ไม่ต้องรอจนครบรอบเดิม)
 * - รอบก่อนยังไม่เสร็จ (รวมถึงยิงช้า) จะไม่ยิงซ้อน
 * - `enabled: false` = หยุดชั่วคราว (ไม่ตั้ง timer เลย) เช่นตอนมีฟอร์มเปิดค้าง/กำลังพิมพ์
 * - ล้าง timer + listener เมื่อ unmount หรือ enabled/interval เปลี่ยน
 *
 * ตั้งใจ "ไม่" ยิงตอน mount — หน้าโหลดข้อมูลครั้งแรกเองอยู่แล้ว การยิงรอบแรกเริ่มเมื่อครบ 1 interval
 * `fetchFn` ควร resolve เมื่อดึงสำเร็จ และ reject เมื่อพลาด: รอบที่พลาดจะไม่อัปเดต `lastUpdated`
 * (และควรปล่อยข้อมูลเดิมไว้ ไม่ล้างทิ้ง — การ refresh เบื้องหลังไม่ควรทำจอว่างเพราะ network กระตุก)
 *
 * @returns `lastUpdated` = เวลาที่ `fetchFn` สำเร็จล่าสุด (null ก่อนรอบแรกที่สำเร็จ)
 */
export function useAutoRefresh(
  fetchFn: () => void | Promise<unknown>,
  intervalMs: number,
  options?: { enabled?: boolean },
): { lastUpdated: Date | null } {
  const enabled = options?.enabled ?? true;
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // เก็บ fetchFn ล่าสุดไว้ใน ref — callback ที่ปิด closure ค่าหน้าใหม่ไม่รีเซ็ต timer
  const fnRef = useRef(fetchFn);
  fnRef.current = fetchFn;
  // true ระหว่างรอบยังไม่จบ — กันยิงซ้อน
  const inFlight = useRef(false);

  const runOnce = useCallback(async () => {
    if (inFlight.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    inFlight.current = true;
    try {
      await fnRef.current();
      setLastUpdated(new Date());
    } catch {
      // รอบที่พลาด: ไม่ขยับ lastUpdated และไม่แตะข้อมูลเดิม
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer = setInterval(() => void runOnce(), intervalMs);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void runOnce(); // กลับมาที่แท็บ = ดึงทันที
      clearInterval(timer); // แล้วตั้งรอบใหม่จากตอนนี้
      timer = setInterval(() => void runOnce(), intervalMs);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, runOnce]);

  return { lastUpdated };
}
