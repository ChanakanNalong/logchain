import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Batch } from '../logs/entities/batch.entity';
import { MetricsService } from './metrics.service';

@Module({
  imports: [TypeOrmModule.forFeature([Batch])],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
