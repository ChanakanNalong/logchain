import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly logsTotal: Counter;
  private readonly ingestHist: Histogram;
  private readonly piiCounter: Counter;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'logchain_' });

    this.logsTotal = new Counter({
      name: 'logchain_logs_ingested_total',
      help: 'Total logs ingested',
      labelNames: ['severity'],
      registers: [this.registry],
    });
    this.ingestHist = new Histogram({
      name: 'logchain_ingest_duration_ms',
      help: 'Ingest latency (ms)',
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.registry],
    });
    this.piiCounter = new Counter({
      name: 'logchain_pii_masked_total',
      help: 'Logs with PII masked',
      registers: [this.registry],
    });
  }

  incrementLogsIngested(severity: string) { this.logsTotal.inc({ severity }); }
  recordIngestDuration(ms: number)        { this.ingestHist.observe(ms); }
  incrementPiiMasked()                    { this.piiCounter.inc(); }

  async getMetrics() { return this.registry.metrics(); }
  getContentType()   { return this.registry.contentType; }
}