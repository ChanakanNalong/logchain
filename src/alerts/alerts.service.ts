import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alert } from './entities/alert.entity';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class AlertsService {
  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
    private notificationService: NotificationService,
  ) {}

  async createOrDedup(dto: Partial<Alert>): Promise<Alert> {
    const existing = await this.alertRepo.findOne({
      where: { status: 'OPEN', alertType: dto.alertType, source: dto.source },
    });
    if (existing) {
      return existing;
    }
    const newAlert = this.alertRepo.create({ ...dto, status: 'OPEN' });
    const saved = await this.alertRepo.save(newAlert);

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
