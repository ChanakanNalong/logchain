/**
 * ช่วงเวลาที่กราฟ Log volume บน dashboard เลือกได้ + ความกว้างของ bucket ที่คู่กัน
 * ('all' คำนวณ bucket ตอน runtime จาก log ที่เก่าที่สุด — ดู pickBucketForSpan)
 */
export const TRAFFIC_RANGES = [
  '1h',
  '6h',
  '24h',
  '7d',
  '30d',
  '6m',
  '12m',
  'all',
] as const;
export type TrafficRange = (typeof TRAFFIC_RANGES)[number];

export const DEFAULT_TRAFFIC_RANGE: TrafficRange = '24h';

export interface BucketSpec {
  /** ความกว้างโดยประมาณเป็นวินาที ใช้เลือกขั้นบันไดของ 'all' เท่านั้น ไม่ได้ใช้ใน SQL */
  seconds: number;
  /** interval ที่ส่งให้ date_bin + generate_series */
  step: string;
  /**
   * bucket แบบปฏิทิน (เดือน/ปี) ความกว้างไม่คงที่ date_bin จึงรับไม่ได้
   * ('ERROR: timestamps cannot be binned into intervals containing months or years')
   * -> ต้องสลับไปใช้ date_trunc กับ unit นี้แทน
   */
  truncUnit?: 'month' | 'year';
  /** จุดตั้งต้นของ date_bin — สัปดาห์เริ่มวันจันทร์ ไม่ใช่วันพฤหัสตาม epoch */
  origin: string;
  /** to_char format ของป้ายแกน X */
  labelFormat: string;
  /** คำเรียก bucket ที่ frontend เอาไปขึ้นว่า "Events per …" */
  name: string;
}

const EPOCH = '1970-01-01';
const FIRST_MONDAY = '1970-01-05';

const BUCKET_DEFS = {
  '5m': {
    seconds: 300,
    step: '5 minutes',
    origin: EPOCH,
    labelFormat: 'HH24:MI',
    name: '5 min',
  },
  '15m': {
    seconds: 900,
    step: '15 minutes',
    origin: EPOCH,
    labelFormat: 'HH24:MI',
    name: '15 min',
  },
  '1h': {
    seconds: 3_600,
    step: '1 hour',
    origin: EPOCH,
    labelFormat: 'HH24:00',
    name: 'hour',
  },
  '6h': {
    seconds: 21_600,
    step: '6 hours',
    origin: EPOCH,
    labelFormat: 'DD Mon HH24:00',
    name: '6 hours',
  },
  '1d': {
    seconds: 86_400,
    step: '1 day',
    origin: EPOCH,
    labelFormat: 'DD Mon',
    name: 'day',
  },
  '1w': {
    seconds: 604_800,
    step: '7 days',
    origin: FIRST_MONDAY,
    labelFormat: 'DD Mon',
    name: 'week',
  },
  '1mo': {
    seconds: 2_592_000,
    step: '1 month',
    truncUnit: 'month',
    origin: EPOCH,
    labelFormat: 'Mon YYYY',
    name: 'month',
  },
  '1y': {
    seconds: 31_536_000,
    step: '1 year',
    truncUnit: 'year',
    origin: EPOCH,
    labelFormat: 'YYYY',
    name: 'year',
  },
} as const;

export type BucketKey = keyof typeof BUCKET_DEFS;

export const BUCKETS: Record<BucketKey, BucketSpec> = BUCKET_DEFS;

/** จำนวน bucket สูงสุดที่ยอมให้ 'all' สร้าง — กันกราฟ (และ query) บานเมื่อ log เก่ามาก */
export const MAX_BUCKETS = 60;

/**
 * ทุกช่วงยกเว้น 'all' ตรึง bucket + จำนวนจุดไว้ตายตัว ผลลัพธ์จึงกว้างเท่าที่ปุ่มบอกเสมอ
 *
 * points = span/bucket **+1** เสมอ — bucket สุดท้ายคือช่วงปัจจุบันที่ยังไม่เต็ม
 * ถ้าไม่บวก จุดเริ่มซีรีส์จะขยับเข้ามาเกือบหนึ่ง bucket แล้ว log ที่อยู่ในช่องว่างนั้น
 * หายจากกราฟทั้งที่ป้ายบอกว่าครอบคลุม (7d เคยรวมได้ 23 ขณะที่ DB มี 24 ใน 7 วันจริง)
 * planAllRange ก็บวก 1 ด้วยเหตุผลเดียวกัน
 */
export const RANGE_SPECS: Record<
  Exclude<TrafficRange, 'all'>,
  { bucket: BucketKey; points: number }
> = {
  '1h': { bucket: '5m', points: 13 },
  '6h': { bucket: '15m', points: 25 },
  '24h': { bucket: '1h', points: 25 },
  '7d': { bucket: '6h', points: 29 },
  '30d': { bucket: '1d', points: 31 },
  '6m': { bucket: '1w', points: 27 },
  '12m': { bucket: '1mo', points: 13 },
};

/** bucket ที่เล็กที่สุดที่คลุม span ทั้งหมดได้ภายใน MAX_BUCKETS จุด */
export function pickBucketForSpan(spanMs: number): BucketKey {
  const keys = Object.keys(BUCKETS) as BucketKey[];
  return (
    keys.find(
      (key) => spanMs / 1000 / BUCKETS[key].seconds + 1 <= MAX_BUCKETS,
    ) ?? keys[keys.length - 1]
  );
}
