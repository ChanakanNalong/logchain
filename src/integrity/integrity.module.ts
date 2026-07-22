import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Log } from "../logs/entities/log.entity";
import { Batch } from "../logs/entities/batch.entity";
import { Alert } from "../alerts/entities/alert.entity";
import { LogBatchMapping } from "../logs/entities/log-batch-mapping.entity";
import { MerkleService } from "./service/merkle.service";
import { IntegrityService } from "./integrity.service";
import { IntegritySchedule } from "./integrity.scheduler";
import { IntegrityController } from "./integrity.controller";
import { BlockchainModule } from "../blockchain/blockchain.module";
import { AuthModule } from "../auth/auth.module";

@Module({
    imports: [
        TypeOrmModule.forFeature([Log, Batch, Alert, LogBatchMapping]),
        BlockchainModule, AuthModule,
    ],
    providers: [MerkleService, IntegrityService, IntegritySchedule],
    controllers: [IntegrityController],
    exports: [IntegrityService],
})
export class IntegrityModule {}
