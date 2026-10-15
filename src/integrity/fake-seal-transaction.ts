import { Batch } from '../logs/entities/batch.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { BatchLogSnapshot } from './entities/batch-log-snapshot.entity';

/**
 * สำหรับ unit test เท่านั้น — mappingRepo.manager ปลอมที่ IntegrityService.writeMappingAndSnapshot ใช้
 * transaction(cb) เรียก cb ทันทีด้วย manager ที่ getRepository() คืน repo ปลอมของเทส
 * snapshot ที่ถูก insert เก็บลง `snapshots` ให้เทสตรวจได้
 */
export function fakeSealManager(repos: {
  batches: () => { save: (b: unknown) => Promise<unknown> };
  mapping: () => { save: (m: unknown) => Promise<unknown> };
  snapshots?: Array<Partial<BatchLogSnapshot>>;
  /** ให้ insert snapshot พัง — จำลอง transaction ล้ม */
  failSnapshot?: () => boolean;
}) {
  return {
    transaction: async <T>(
      cb: (m: { getRepository: (e: unknown) => unknown }) => Promise<T>,
    ): Promise<T> =>
      cb({
        getRepository: (entity: unknown) => {
          if (entity === Batch) return repos.batches();
          if (entity === LogBatchMapping) return repos.mapping();
          if (entity === BatchLogSnapshot) {
            return {
              insert: (rows: Array<Partial<BatchLogSnapshot>>) => {
                if (repos.failSnapshot?.()) {
                  return Promise.reject(new Error('snapshot insert failed'));
                }
                repos.snapshots?.push(...rows);
                return Promise.resolve({ identifiers: [] });
              },
            };
          }
          throw new Error(`unexpected repository ${String(entity)}`);
        },
      }),
  };
}
