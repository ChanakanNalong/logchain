import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IntegritySchedule, SEAL_CRON_JOB } from './integrity.scheduler';
import { IntegrityService } from './integrity.service';
import { readSealConfig } from './seal-config';

/** SEAL_CRON ลงทะเบียนตอน boot — ไม่ตั้ง = ทุกนาทีเหมือนเดิม · ตั้งผิด = boot ล้ม */
describe('IntegritySchedule — seal cron', () => {
  const jobs: CronJob[] = [];
  afterEach(() => jobs.splice(0).forEach((j) => void j.stop()));

  function boot(env: Record<string, string>) {
    const integrity = {
      sealConfig: readSealConfig(env),
      runScheduledSeal: jest.fn(),
    } as unknown as IntegrityService;
    const registry = {
      addCronJob: jest.fn((_name: string, job: CronJob) => jobs.push(job)),
    } as unknown as SchedulerRegistry;
    new IntegritySchedule(integrity, registry).onModuleInit();
    return registry.addCronJob as jest.Mock;
  }

  it('defaults to every minute', () => {
    const add = boot({});
    expect(add).toHaveBeenCalledWith(SEAL_CRON_JOB, expect.any(CronJob));
    expect(jobs[0].cronTime.source).toBe(CronExpression.EVERY_MINUTE);
  });

  it('uses SEAL_CRON', () => {
    boot({ SEAL_CRON: '0 */30 * * * *' });
    expect(jobs[0].cronTime.source).toBe('0 */30 * * * *');
  });

  it('fails at boot on an invalid SEAL_CRON', () => {
    expect(() => boot({ SEAL_CRON: 'every 30 minutes' })).toThrow();
  });
});
