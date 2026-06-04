import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alert } from './entities/alert.entity';
import * as crypto from 'crypto';

@Injectable()
export class AlertsService {
  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
  ) {}

  private fingerprint(alert: Partial<Alert>): string {
    const str = `${alert.alertType}-${alert.source}-${alert.severity}`;
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  async createOrDedup(dto: Partial<Alert>): Promise<Alert> {
    const fp = this.fingerprint(dto);
    const existing = await this.alertRepo.findOne({
      where: { status: 'OPEN', alertType: dto.alertType, source: dto.source },
    });
    if (existing) {
      return existing;
    }
    const newAlert = this.alertRepo.create({ ...dto, status: 'OPEN' });
    return this.alertRepo.save(newAlert);
  }

  async findAll(): Promise<Alert[]> {
    return this.alertRepo.find({ order: { createAt: 'DESC' } });
  }

  async resolve(id: string): Promise<Alert> {
    const alert = await this.alertRepo.findOneOrFail({ where: { id } });
    alert.status = 'RESOLVED';
    return this.alertRepo.save(alert);
  }
}
