import { retentionDays } from './retention.service';

describe('retentionDays', () => {
  it('defaults to 365 days for both tables', () => {
    expect(retentionDays(undefined)).toEqual({ alerts: 365, audit: 365 });
  });

  it('never deletes audit_access younger than 12 months (PCI 10.5.1) even if RETENTION_DAYS is lower', () => {
    expect(retentionDays('90')).toEqual({ alerts: 90, audit: 365 });
  });

  it('keeps audit longer when RETENTION_DAYS is above the floor', () => {
    expect(retentionDays('400')).toEqual({ alerts: 400, audit: 400 });
  });
});
