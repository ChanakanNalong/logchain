import { Injectable, Logger } from '@nestjs/common';
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
    // batchId ต้องอยู่ในเงื่อนไขด้วย ให้ตรงกับ idx_alerts_open_dedup
    // ไม่งั้น integrity alert ของคนละ batch จะถูกมองว่าซ้ำกัน
    const dedupWhere = {
      status: 'OPEN',
      alertType: dto.alertType,
      source: dto.source,
      batchId: dto.batchId ?? IsNull(),
    };

    const existing = await this.alertRepo.findOne({ where: dedupWhere });
    if (existing) {
      return existing;
    }

    const newAlert = this.alertRepo.create({ ...dto, status: 'OPEN' });

    let saved: Alert;
    try {
      saved = await this.alertRepo.save(newAlert);
    } catch (err: any) {
      // 23505 = unique_violation จาก idx_alerts_open_dedup
      // findOne...save ไม่ atomic — request ที่มาพร้อมกันอาจเห็น "ยังไม่มี" ทั้งคู่
      // DB เป็นตัวตัดสิน ฝั่งที่แพ้ก็แค่ดึงตัวที่ชนะกลับมา ไม่ใช่ error จริง
      const code = err.code ?? err.driverError?.code;
      if (code === '23505') {
        const winner = await this.alertRepo.findOne({ where: dedupWhere });
        if (winner) {
          this.logger.debug(
            `Dedup race lost for ${dto.alertType}/${dto.source} — returning existing alert`,
          );
          return winner;
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

  async findAll(): Promise<Alert[]> {
    return this.alertRepo.find({ order: { createdAt: 'DESC' } });
  }

  async resolve(id: string): Promise<Alert> {
    const alert = await this.alertRepo.findOneOrFail({ where: { id } });
    alert.status = 'RESOLVED';
    return this.alertRepo.save(alert);
  }
}
