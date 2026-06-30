import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

/**
 * MetricsController — Prometheus scrape endpoint
 * GET /metrics  → text/plain ในรูปแบบ Prometheus exposition format
 * (audit interceptor ข้าม path นี้อยู่แล้ว)
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.getContentType());
    res.send(await this.metrics.getMetrics());
  }
}
