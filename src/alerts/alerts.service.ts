import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Alert } from './entities/alert.entity';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
    private notificationService: NotificationService,
  ) {}

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
      return this.recordRepeat(existing);
    }

    // occurrenceCount/lastSeenAt ใช้ค่าของ DB เสมอ ไม่รับจาก body ของ POST /alerts
    const newAlert = this.alertRepo.create({
      ...dto,
      ruleId,
      status: 'OPEN',
      occurrenceCount: 1,
      lastSeenAt: undefined,
    });

    let saved: Alert;
    try {
      saved = await this.alertRepo.save(newAlert);
    } catch (err: any) {
      // 23505 = unique_violation จาก idx_alerts_open_dedup_rule
      // findOne...save ไม่ atomic — request ที่มาพร้อมกันอาจเห็น "ยังไม่มี" ทั้งคู่
      // DB เป็นตัวตัดสิน ฝั่งที่แพ้ก็แค่นับเป็นการเกิดซ้ำของตัวที่ชนะ ไม่ใช่ error จริง
      const code = err.code ?? err.driverError?.code;
      if (code === '23505') {
        const winner = await this.alertRepo.findOne({ where: dedupWhere });
        if (winner) {
          this.logger.debug(
            `Dedup race lost for ${dto.alertType}/${dto.source} — counting as a repeat`,
          );
          return this.recordRepeat(winner);
        }
      }
      throw err;
    }

    if (dto.severity && ['HIGH', 'CRITICAL'].includes(dto.severity)) {
      await this.notificationService.sendAlertEmail(
        dto.severity,
        dto.title ?? 'Alert',
        JSON.stringify(dto.detail ?? {}),
      );
    }

    return saved;
  }

  /**
   * นับการเกิดซ้ำแทนการทิ้งเฉย ๆ — ให้ analyst เห็นว่าโดนกี่ครั้ง ล่าสุดเมื่อไร (PCI DSS Req 10)
   * บวกใน SQL ไม่ใช่ read-modify-write ฝั่งแอป ไม่งั้น alert ที่มาพร้อมกันนับหาย
   */
  private async recordRepeat(alert: Alert): Promise<Alert> {
    const result = await this.alertRepo
      .createQueryBuilder()
      .update(Alert)
      .set({
        occurrenceCount: () => 'occurrence_count + 1',
        lastSeenAt: () => 'now()',
      })
      .where('id = :id', { id: alert.id })
      .returning(['occurrence_count', 'last_seen_at'])
      .execute();

    const row = (result.raw as any[])?.[0];
    if (row) {
      alert.occurrenceCount = Number(row.occurrence_count);
      alert.lastSeenAt = new Date(row.last_seen_at);
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
  const raw = dto.ruleId ?? (dto.detail as any)?.rule_id;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
}
