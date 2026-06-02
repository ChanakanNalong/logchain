import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from 'typeorm';
import { AuditAccess } from './entities/audit-access.entity';

export interface AuditEntry {
    userId: string;
    username?: string | null;
    action: string;
    resource: string;
    method?: string | null;
    statusCode?: number | null;
    ipAddress?: string | null;
    durationMs?: number | null;
}

@Injectable()
export class AuditService {
    private readonly logger = new Logger (AuditService.name);

    constructor(
        @InjectRepository(AuditAccess)
        private readonly repo: Repository<AuditAccess>,
    ) {}

    async log(entry: AuditEntry): Promise<void> {
        try {
            // สร้าง failure ต้องไม่ทำให้ main request พัง
            await this.repo.save(this.repo.create(entry));
        } catch (err) {
            // audit failure ต้องไม่ทำให้ main request พัง
            // log ลง stderr ให้ ops รู้แต่ไม่ throw
            this.logger.error('Audit write failed', err);
        }
    }
}