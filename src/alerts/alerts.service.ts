import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { isIP } from 'net';
import { ALERT_COLUMN_LENGTH, Alert } from './entities/alert.entity';
import { ALERT_LOG_ROLES, AlertLogRole } from './entities/alert-log.entity';
import { NotificationService } from '../notification/notification.service';
import { normalizeIp } from '../logs/services/log-hash';

/** severity ที่ส่ง email — ทั้งตอนสร้างและตอนเกิดซ้ำ */
const NOTIFY_SEVERITIES = ['HIGH', 'CRITICAL'];

/** ลำดับความรุนแรง ต่ำ → สูง — ค่าที่ไม่รู้จักถือว่าต่ำสุด */
const SEVERITY_RANK = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'];

/** เตือนซ้ำได้ถี่สุดเท่าไร ถ้า alert ยังเกิดซ้ำต่อเนื่อง (0 = ไม่เตือนซ้ำ) */
const DEFAULT_RENOTIFY_MINUTES = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** log หลักฐานของ alert ที่ detection ส่งมา (detection/app/alert_payload.py) */
export interface AlertLogLinks {
  /** log ในหน้าต่างของ threshold rule (รวม trigger) */
  relatedLogIds?: unknown;
  /** log ของ rule ก่อนหน้าในกฎแบบ chain (5715 → 5710) */
  priorLogIds?: unknown;
}

/** log ของ alert สำหรับ GET /alerts/:id */
export interface AlertLogView {
  id: string;
  role: AlertLogRole;
  message: string;
  sourceIp: string | null;
  createdAt: Date;
  batchStatus: string | null;
}

/** alert ที่อ้างถึง log หนึ่ง สำหรับ GET /logs/:id/detail */
export interface LogAlertView {
  id: string;
  alertType: string;
  ruleId: string | null;
  severity: string;
  title: string;
  status: string;
  sourceIp: string | null;
  occurrenceCount: number;
  createdAt: Date;
  lastSeenAt: Date;
  role: AlertLogRole;
}

/** ORDER BY ตามลำดับ role (trigger ก่อน) — ใช้ใน SQL */
const roleOrder = (col: string) =>
  `array_position(ARRAY[${ALERT_LOG_ROLES.map((r) => `'${r}'`).join(',')}]::text[], ${col}::text)`;

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

  async createOrDedup(
    input: Partial<Alert>,
    links: AlertLogLinks = {},
  ): Promise<Alert> {
    // ตัดก่อนสร้าง dedup key — key ต้องเป็นค่าเดียวกับที่ลง DB จริง
    const { dto, ruleId } = this.fitToColumns(
      { ...input, sourceIp: this.cleanIp(input.sourceIp) },
      ruleIdOf(input),
    );

    // key ต้องตรงกับ idx_alerts_open_dedup_rule เป๊ะ (AlertsRuleDedup migration)
    // ไม่งั้น insert ชน 23505 แล้ว findOne ด้านล่างหาตัวที่ชนะไม่เจอ
    // batchId: integrity alert ของคนละ batch ไม่ใช่ตัวเดียวกัน
    // ruleId: rule คนละตัวบน host เดียวกันไม่ใช่ตัวเดียวกัน — เดิมไม่มี ทำให้ 5715
    //         (login สำเร็จหลัง brute force) ถูกกลืนเข้า 5710 ที่ค้าง OPEN อยู่
    // sourceIp: forwarder ตัวเดียว (source เดียว) ส่ง log ของผู้โจมตีหลาย IP — คนละ IP = คนละ alert
    const dedupWhere = {
      status: 'OPEN',
      alertType: dto.alertType,
      source: dto.source,
      batchId: dto.batchId ?? IsNull(),
      ruleId: ruleId ?? IsNull(),
      sourceIp: dto.sourceIp ?? IsNull(),
    };

    const existing = await this.alertRepo.findOne({ where: dedupWhere });
    if (existing) {
      return this.recordRepeatWithLogs(existing, dto, links);
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
          return this.recordRepeatWithLogs(winner, dto, links);
        }
      }
      throw err;
    }

    // log ที่เป็นหลักฐาน: trigger ก่อน แล้ว window / prior — log ที่ซ้ำกันได้ role แรก
    await this.linkLogs(saved.id, [
      ['trigger', [dto.logId]],
      ['window', idList(links.relatedLogIds)],
      ['prior', idList(links.priorLogIds)],
    ]);

    // ไม่รอ SMTP — alert ลง DB แล้วคือจบงานของ request / Kafka message นี้ (sendAlertEmail จับ error เอง)
    // เดิม await: Gmail ช้า 3–7 วิต่อฉบับ และช้ากว่านั้นได้เป็นนาทีตอนส่งถี่ → consumer ของ alerts.raw ค้างตาม
    // และ e2e `creates an alert` เกิน timeout เป็นระยะ (worklog 2026-09-24 หัวข้อ 12)
    if (notify) {
      void this.notificationService.sendAlertEmail(
        dto.severity!,
        dto.title ?? 'Alert',
        JSON.stringify(dto.detail ?? {}),
      );
    }

    return saved;
  }

  /**
   * ตัดค่าที่ยาวเกินคอลัมน์ให้พอดี แทนการปล่อยให้ INSERT ชน `value too long` (22001) แล้ว alert หาย
   *
   * เคยหายจริง: alerts.source เป็น 32 แต่ log ยอม source 128 (ขยายแล้วใน AlertsSourceLength migration)
   * ฟิลด์เหล่านี้มาจาก detection / POST /alerts ซึ่งไม่ผ่าน DTO ของ alert — ถ้าวันหน้ามีฝั่งไหนยาวขึ้นอีก
   * alert ยังต้องเข้า DB ได้ · log WARN ทุกครั้งที่ตัด และเก็บค่าเต็มไว้ที่ detail.truncated_fields
   * นับความยาวเป็นตัวอักษร (code point) แบบเดียวกับ varchar(n) ของ Postgres
   */
  private fitToColumns(
    dto: Partial<Alert>,
    ruleId: string | null,
  ): { dto: Partial<Alert>; ruleId: string | null } {
    const cut: Record<string, string> = {};
    const fit = <T>(field: keyof typeof ALERT_COLUMN_LENGTH, value: T): T => {
      if (typeof value !== 'string') return value;
      const chars = Array.from(value);
      const max = ALERT_COLUMN_LENGTH[field];
      if (chars.length <= max) return value;
      cut[field] = value;
      return chars.slice(0, max).join('') as T;
    };

    const out: Partial<Alert> = { ...dto };
    for (const f of ['alertType', 'severity', 'source'] as const) {
      if (f in out) out[f] = fit(f, out[f]);
    }
    const fittedRuleId = fit('ruleId', ruleId);

    const fields = Object.keys(cut);
    if (fields.length > 0) {
      this.logger.warn(
        `Alert ${String(out.alertType)} (log_id=${out.logId ?? '-'}) ` +
          fields
            .map(
              (f) =>
                `${f} ยาว ${Array.from(cut[f]).length} ตัว เกินคอลัมน์ ${ALERT_COLUMN_LENGTH[f as keyof typeof ALERT_COLUMN_LENGTH]}`,
            )
            .join(', ') +
          ` — ตัดให้พอดีแล้วบันทึกต่อ (ค่าเต็มอยู่ที่ detail.truncated_fields)`,
      );
      const detail =
        out.detail &&
        typeof out.detail === 'object' &&
        !Array.isArray(out.detail)
          ? out.detail
          : {};
      out.detail = { ...detail, truncated_fields: cut };
    }
    return { dto: out, ruleId: fittedRuleId };
  }

  /** เกิดซ้ำ: นับ + ผูก log ของครั้งนี้เป็น repeat (log ที่ผูกไว้แล้วคง role เดิม) */
  private async recordRepeatWithLogs(
    alert: Alert,
    incoming: Partial<Alert>,
    links: AlertLogLinks,
  ): Promise<Alert> {
    const updated = await this.recordRepeat(alert, incoming);
    await this.linkLogs(alert.id, [
      ['repeat', [incoming.logId, ...idList(links.relatedLogIds)]],
    ]);
    return updated;
  }

  /**
   * INSERT alert_logs ใน statement เดียว — ลำดับใน groups = ลำดับความสำคัญของ role
   * (DISTINCT ON เลือก role แรกของ log ที่ซ้ำกัน · ON CONFLICT คง role ที่ผูกไว้ก่อน)
   * JOIN logs: ข้าม id ที่ไม่มีอยู่จริง (POST /alerts ใส่อะไรก็ได้) แทนการชน FK แล้ว alert พัง
   * ผูกไม่สำเร็จต้องไม่ทำให้ alert หาย — alert ลง DB แล้ว ลิงก์เป็นของเสริม
   */
  private async linkLogs(
    alertId: string,
    groups: Array<[AlertLogRole, Array<string | null | undefined>]>,
  ): Promise<void> {
    const ids: string[] = [];
    const roles: string[] = [];
    const prios: number[] = [];
    groups.forEach(([role, list], prio) => {
      for (const id of list) {
        if (typeof id === 'string' && UUID_RE.test(id)) {
          ids.push(id);
          roles.push(role);
          prios.push(prio);
        }
      }
    });
    if (ids.length === 0) return;

    try {
      await this.alertRepo.query(
        `INSERT INTO alert_logs (alert_id, log_id, role)
         SELECT DISTINCT ON (l.id) $1::uuid, l.id, x.role
           FROM unnest($2::uuid[], $3::text[], $4::int[]) AS x(log_id, role, prio)
           JOIN logs l ON l.id = x.log_id
          ORDER BY l.id, x.prio
         ON CONFLICT DO NOTHING`,
        [alertId, ids, roles, prios],
      );
    } catch (err) {
      this.logger.warn(
        `Cannot link ${ids.length} log(s) to alert ${alertId}: ${(err as Error).message}`,
      );
    }
  }

  /** IP ที่ Postgres inet รับได้ · อย่างอื่น (POST /alerts ใส่มั่ว) = null แทนการชน 22P02 */
  private cleanIp(ip: unknown): string | null {
    if (typeof ip !== 'string' || !ip.trim()) return null;
    const v = ip.trim();
    if (!isIP(v)) {
      this.logger.warn(
        `Alert sourceIp "${v.slice(0, 64)}" is not an IP — stored as null`,
      );
      return null;
    }
    return normalizeIp(v);
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
      // ไม่รอ SMTP — เหตุผลเดียวกับใน createOrDedup
      void this.notificationService.sendAlertEmail(
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

  /** alert + log ทั้งหมดที่ผูกไว้ (GET /alerts/:id) */
  async findOneWithLogs(
    id: string,
  ): Promise<{ alert: Alert; logs: AlertLogView[] }> {
    const alert = await this.alertRepo.findOne({ where: { id } });
    if (!alert) throw new NotFoundException('Alert not found');

    // alerts.log_id ของ alert ที่สร้างก่อนมี alert_logs ก็นับเป็น trigger
    const rows: Array<{
      id: string;
      role: AlertLogRole;
      message: string;
      source_ip: string | null;
      created_at: Date;
      batch_status: string | null;
    }> = await this.alertRepo.query(
      `SELECT l.id, x.role, l.message, host(l.source_id) AS source_ip,
              l.created_at, b.status AS batch_status
         FROM (SELECT DISTINCT ON (log_id) log_id, role
                 FROM (SELECT log_id, role FROM alert_logs WHERE alert_id = $1
                       UNION ALL
                       SELECT log_id, 'trigger' FROM alerts WHERE id = $1 AND log_id IS NOT NULL) u
                ORDER BY log_id, ${roleOrder('role')}) x
         JOIN logs l ON l.id = x.log_id
         LEFT JOIN log_batch_mapping m ON m.log_id = l.id
         LEFT JOIN batches b ON b.id = m.batch_id
        ORDER BY ${roleOrder('x.role')}, l.created_at, l.id`,
      [id],
    );

    return {
      alert,
      logs: rows.map((r) => ({
        id: r.id,
        role: r.role,
        message: r.message,
        sourceIp: r.source_ip,
        createdAt: new Date(r.created_at),
        batchStatus: r.batch_status,
      })),
    };
  }

  /** alert ทุกใบที่อ้างถึง log นี้ (GET /logs/:id/detail) — ใหม่สุดก่อน */
  async findForLog(logId: string): Promise<LogAlertView[]> {
    const rows: Array<{
      id: string;
      alert_type: string;
      rule_id: string | null;
      severity: string;
      title: string;
      status: string;
      source_ip: string | null;
      occurrence_count: number;
      created_at: Date;
      last_seen_at: Date;
      role: AlertLogRole;
    }> = await this.alertRepo.query(
      `SELECT a.id, a.alert_type, a.rule_id, a.severity, a.title, a.status,
              host(a.source_ip) AS source_ip, a.occurrence_count, a.created_at,
              a.last_seen_at, x.role
         FROM (SELECT DISTINCT ON (alert_id) alert_id, role
                 FROM (SELECT alert_id, role FROM alert_logs WHERE log_id = $1
                       UNION ALL
                       SELECT id, 'trigger' FROM alerts WHERE log_id = $1) u
                ORDER BY alert_id, ${roleOrder('role')}) x
         JOIN alerts a ON a.id = x.alert_id
        ORDER BY a.last_seen_at DESC, a.id`,
      [logId],
    );
    return rows.map((r) => ({
      id: r.id,
      alertType: r.alert_type,
      ruleId: r.rule_id,
      severity: r.severity,
      title: r.title,
      status: r.status,
      sourceIp: r.source_ip,
      occurrenceCount: Number(r.occurrence_count),
      createdAt: new Date(r.created_at),
      lastSeenAt: new Date(r.last_seen_at),
      role: r.role,
    }));
  }

  /**
   * ปิด alert เป็น RESOLVED พร้อมบันทึก resolution ลง detail (jsonb) — ไม่มี
   * migration/คอลัมน์ใหม่ · resolve ซ้ำบน RESOLVED ได้ (อัปเดต resolution ไว้
   * เติม note ย้อนหลัง) · ไม่ส่ง note มา = เก็บ note เดิมไว้
   */
  async resolve(id: string, note?: string, by?: string | null): Promise<Alert> {
    // findOneOrFail โยน EntityNotFoundError ซึ่ง AllExceptionsFilter แปลงเป็น 500
    // ทั้งที่เป็นเรื่อง input ผิด — หน้า Alerts จะได้แยก "ไม่เจอ" ออกจาก "ระบบพัง"
    const alert = await this.alertRepo.findOne({ where: { id } });
    if (!alert) throw new NotFoundException('Alert not found');

    const detail: Record<string, unknown> =
      alert.detail && typeof alert.detail === 'object'
        ? { ...(alert.detail as Record<string, unknown>) }
        : {};
    const prev =
      detail.resolution && typeof detail.resolution === 'object'
        ? (detail.resolution as { note?: string | null })
        : null;
    // note ที่ไม่ได้ส่งมา (undefined) = เก็บของเดิม · ส่ง "" มา = ล้าง note
    const nextNote = note !== undefined ? note : (prev?.note ?? null);

    alert.status = 'RESOLVED';
    alert.detail = {
      ...detail,
      resolution: {
        note: nextNote && nextNote.length > 0 ? nextNote : null,
        by: by ?? null,
        at: new Date().toISOString(),
      },
    };
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

/** list ของ UUID จาก payload (อะไรที่ไม่ใช่ array = ว่าง) */
function idList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : [];
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
