import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [TypeOrmModule.forFeature([Log, Batch, Alert])],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
