import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Alert } from './entities/alert.entity';
import { NotificationService } from '../notification/notification.service';

/** severity ที่ส่ง email — ทั้งตอนสร้างและตอนเกิดซ้ำ */
const NOTIFY_SEVERITIES = ['HIGH', 'CRITICAL'];

/** ลำดับความรุนแรง ต่ำ → สูง — ค่าที่ไม่รู้จักถือว่าต่ำสุด */
const SEVERITY_RANK = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'];

/** เตือนซ้ำได้ถี่สุดเท่าไร ถ้า alert ยังเกิดซ้ำต่อเนื่อง (0 = ไม่เตือนซ้ำ) */
const DEFAULT_RENOTIFY_MINUTES = 60;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly renotifyMinutes: number;

  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
    private notificationService: NotificationService,
    config: ConfigService,
  ) {
    // ไม่ตั้ง / ว่าง / ค่าเพี้ยน → ค่าตั้งต้น (Number('') = 0 ซึ่งแปลว่าปิด ต้องกันไว้)
    const raw = config.get<string>('ALERT_RENOTIFY_MINUTES');
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    this.renotifyMinutes =
      Number.isInteger(n) && n >= 0 ? n : DEFAULT_RENOTIFY_MINUTES;
  }

  async createOrDedup(dto: Partial<Alert>): Promise<Alert> {
    const ruleId = ruleIdOf(dto);

    // key ต้องตรงกับ idx_alerts_open_dedup_rule เป๊ะ (AlertsRuleDedup migration)
    // ไม่งั้น insert ชน 23505 แล้ว findOne ด้านล่างหาตัวที่ชนะไม่เจอ
    // batchId: integrity alert ของคนละ batch ไม่ใช่ตัวเดียวกัน
    // ruleId: rule คนละตัวบน host เดียวกันไม่ใช่ตัวเดียวกัน — เดิมไม่มี ทำให้ 5715
    //         (login สำเร็จหลัง brute force) ถูกกลืนเข้า 5710 ที่ค้าง OPEN อยู่
    const dedupWhere = {
      status: 'OPEN',
      alertType: dto.alertType,
      source: dto.source,
      batchId: dto.batchId ?? IsNull(),
      ruleId: ruleId ?? IsNull(),
    };

    const existing = await this.alertRepo.findOne({ where: dedupWhere });
    if (existing) {
      return this.recordRepeat(existing, dto);
    }

    const notify = NOTIFY_SEVERITIES.includes(dto.severity ?? '');

    // occurrenceCount/lastSeenAt/lastNotifiedAt ใช้ค่าของระบบเสมอ ไม่รับจาก body ของ POST /alerts
    const newAlert = this.alertRepo.create({
      ...dto,
      ruleId,
      status: 'OPEN',
      occurrenceCount: 1,
      lastSeenAt: undefined,
      lastNotifiedAt: notify ? new Date() : null,
    });

    let saved: Alert;
    try {
      saved = await this.alertRepo.save(newAlert);
    } catch (err: unknown) {
      // 23505 = unique_violation จาก idx_alerts_open_dedup_rule
      // findOne...save ไม่ atomic — request ที่มาพร้อมกันอาจเห็น "ยังไม่มี" ทั้งคู่
      // DB เป็นตัวตัดสิน ฝั่งที่แพ้ก็แค่นับเป็นการเกิดซ้ำของตัวที่ชนะ ไม่ใช่ error จริง
      const code = pgErrorCode(err);
      if (code === '23505') {
        const winner = await this.alertRepo.findOne({ where: dedupWhere });
        if (winner) {
          this.logger.debug(
            `Dedup race lost for ${dto.alertType}/${dto.source} — counting as a repeat`,
          );
          return this.recordRepeat(winner, dto);
        }
      }
      throw err;
    }

    if (notify) {
      await this.notificationService.sendAlertEmail(
        dto.severity!,
        dto.title ?? 'Alert',
        JSON.stringify(dto.detail ?? {}),
      );
    }

    return saved;
  }

  /**
   * นับการเกิดซ้ำแทนการทิ้งเฉย ๆ — ให้ analyst เห็นว่าโดนกี่ครั้ง ล่าสุดเมื่อไร (PCI DSS Req 10)
   *
   * ทำทุกอย่างใน UPDATE เดียว ไม่ read-modify-write ฝั่งแอป:
   *  - occurrence_count + 1 — alert ที่มาพร้อมกันไม่นับหาย
   *  - severity ขยับขึ้นเป็นตัวที่แรงกว่า — ML ให้ severity ต่างกันทุก event แต่ dedup key ไม่มี
   *    severity ถ้าไม่ขยับ CRITICAL ที่มาตอน WARNING ค้าง OPEN จะไม่เคยถูก email เลย
   *  - last_notified_at = now() เมื่อควรเตือน: severity ถึงเกณฑ์ และ (ยังไม่เคยเตือน หรือเตือน
   *    ล่าสุดนานกว่า renotifyMinutes) — row lock ของ UPDATE ทำให้ event ที่มาพร้อมกัน
   *    มีแค่ตัวเดียวที่เห็นเงื่อนไขเป็นจริง จึงไม่ส่ง email ซ้ำกันหลายฉบับ
   */
  private async recordRepeat(
    alert: Alert,
    incoming: Partial<Alert>,
  ): Promise<Alert> {
    const rank = (expr: string) =>
      `COALESCE(array_position(ARRAY[${SEVERITY_RANK.map((s) => `'${s}'`).join(',')}]::text[], ${expr}::text), 0)`;
    const newSeverity = `CASE WHEN ${rank(':incomingSeverity')} > ${rank('severity')} THEN :incomingSeverity ELSE severity END`;
    const shouldNotify =
      `(${newSeverity}) IN (${NOTIFY_SEVERITIES.map((s) => `'${s}'`).join(',')}) ` +
      `AND (last_notified_at IS NULL OR ` +
      `(:renotifyMinutes > 0 AND last_notified_at <= now() - make_interval(mins => :renotifyMinutes)))`;

    const result = await this.alertRepo
      .createQueryBuilder()
      .update(Alert)
      .set({
        occurrenceCount: () => 'occurrence_count + 1',
        lastSeenAt: () => 'now()',
        severity: () => newSeverity,
        lastNotifiedAt: () =>
          `CASE WHEN ${shouldNotify} THEN now() ELSE last_notified_at END`,
      })
      .where('id = :id', { id: alert.id })
      .setParameters({
        incomingSeverity: incoming.severity ?? '',
        renotifyMinutes: this.renotifyMinutes,
      })
      // now() คงที่ตลอด statement — ค่าที่เพิ่งตั้งจึงเท่ากับ now() พอดี = รอบนี้ต้องส่ง
      .returning(
        'occurrence_count, last_seen_at, severity, last_notified_at, ' +
          'COALESCE(last_notified_at = now(), false) AS notify_now',
      )
      .execute();

    const row = (result.raw as RepeatRow[] | undefined)?.[0];
    if (!row) return alert;

    alert.occurrenceCount = Number(row.occurrence_count);
    alert.lastSeenAt = new Date(row.last_seen_at);
    alert.severity = row.severity;
    alert.lastNotifiedAt = row.last_notified_at
      ? new Date(row.last_notified_at)
      : null;

    if (row.notify_now) {
      await this.notificationService.sendAlertEmail(
        alert.severity,
        alert.title ?? incoming.title ?? 'Alert',
        JSON.stringify(incoming.detail ?? alert.detail ?? {}),
        {
          occurrences: alert.occurrenceCount,
          firstSeen: alert.createdAt,
          lastSeen: alert.lastSeenAt,
        },
      );
    }
    return alert;
  }

  async findAll(): Promise<Alert[]> {
    // เรียงตามครั้งล่าสุดที่เกิด — alert เก่าที่เพิ่งโดนซ้ำต้องขึ้นมาบนสุด ไม่จมอยู่ตามวันที่สร้าง
    return this.alertRepo.find({ order: { lastSeenAt: 'DESC' } });
  }

  async resolve(id: string): Promise<Alert> {
    // findOneOrFail โยน EntityNotFoundError ซึ่ง AllExceptionsFilter แปลงเป็น 500
    // ทั้งที่เป็นเรื่อง input ผิด — หน้า Alerts จะได้แยก "ไม่เจอ" ออกจาก "ระบบพัง"
    const alert = await this.alertRepo.findOne({ where: { id } });
    if (!alert) throw new NotFoundException('Alert not found');

    alert.status = 'RESOLVED';
    return this.alertRepo.save(alert);
  }
}

/**
 * rule_id ของ alert — ส่งมาตรง ๆ หรืออยู่ใน detail.rule_id (รูปแบบของ detection/app/consumer.py)
 * detection ส่งเป็นตัวเลข (5710) เก็บเป็น string ให้ตรงกับ detail->>'rule_id' ที่ migration backfill
 */
function ruleIdOf(dto: Partial<Alert>): string | null {
  const detail = dto.detail as { rule_id?: string | number | null } | null;
  const raw = dto.ruleId ?? detail?.rule_id;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
}

/** แถวที่ UPDATE ... RETURNING ของ recordRepeat คืนมา (ชื่อคอลัมน์ของ Postgres) */
interface RepeatRow {
  occurrence_count: number | string;
  last_seen_at: string | Date;
  severity: string;
  last_notified_at: string | Date | null;
  notify_now: boolean;
}

/** SQLSTATE ของ error จาก pg — TypeORM ห่อไว้ใน driverError อีกชั้น */
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code ?? e?.driverError?.code;
}
