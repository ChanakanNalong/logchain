import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { NotificationService } from '../notification/notification.service';

/** แถวดิบที่ UPDATE ... RETURNING คืนมา (ชื่อคอลัมน์ของ Postgres) */
interface RawRepeatRow {
  occurrence_count: number;
  last_seen_at: string;
  severity: string;
  last_notified_at: string | null;
  notify_now: boolean;
}

type FindOneArgs = { where: Record<string, unknown> };
type EmailArgs = [
  string,
  string,
  string,
  { occurrences: number; firstSeen: Date; lastSeen: Date }?,
];

/** query builder ของ UPDATE — ใส่ type ให้ .mock.calls อ่านได้โดยไม่ต้องแคสต์ */
interface UpdateQbMock {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  setParameters: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock<Promise<{ raw: RawRepeatRow[] }>, []>;
}

interface RepoMock {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
}

/** เติมฟิลด์ที่เหลือให้ fixture เป็น Alert เต็มใบ — cast ที่เดียว ไม่ต้องโรย any ทั้งไฟล์ */
const asAlert = (p: Partial<Alert>): Alert =>
  ({ id: 'alert-id', status: 'OPEN', occurrenceCount: 1, ...p }) as Alert;

describe('AlertsService', () => {
  let service: AlertsService;
  let mockRepo: RepoMock;
  let mockNotification: { sendAlertEmail: jest.Mock<Promise<void>, EmailArgs> };
  let updateQb: UpdateQbMock;
  let env: Record<string, string | undefined>;

  /** แถวที่ UPDATE ... RETURNING คืนมา — ค่าตั้งต้น = เกิดซ้ำแต่ยังไม่ถึงเวลาเตือน */
  function returning(row: Partial<RawRepeatRow> = {}) {
    updateQb.execute.mockResolvedValue({
      raw: [
        {
          occurrence_count: 2,
          last_seen_at: '2026-09-23T01:00:00.000Z',
          severity: 'CRITICAL',
          last_notified_at: '2026-09-23T00:30:00.000Z',
          notify_now: false,
          ...row,
        },
      ],
    });
  }

  async function build() {
    const module = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: getRepositoryToken(Alert), useValue: mockRepo },
        { provide: NotificationService, useValue: mockNotification },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    service = module.get<AlertsService>(AlertsService);
  }

  /** อ่าน argument ของ mock แบบมี type — cast ที่นี่ที่เดียวแทนการปล่อย any ทั้งไฟล์ */
  const callsOf = (m: jest.Mock): unknown[][] => m.mock.calls as unknown[][];
  const setValues = () =>
    callsOf(updateQb.set)[0][0] as Record<string, () => string>;
  const savedAlert = (n = 0) => callsOf(mockRepo.save)[n][0] as Partial<Alert>;
  const findOneWhere = (n = 0) =>
    (callsOf(mockRepo.findOne)[n][0] as FindOneArgs).where;
  const emailArgs = (n = 0) =>
    callsOf(mockNotification.sendAlertEmail)[n] as EmailArgs;

  beforeEach(async () => {
    env = {};
    // UPDATE ... SET occurrence_count = occurrence_count + 1 RETURNING ...
    updateQb = {
      update: jest.fn(() => updateQb),
      set: jest.fn(() => updateQb),
      where: jest.fn(() => updateQb),
      setParameters: jest.fn(() => updateQb),
      returning: jest.fn(() => updateQb),
      execute: jest.fn<Promise<{ raw: RawRepeatRow[] }>, []>(),
    };
    mockRepo = {
      findOne: jest.fn(),
      create: jest.fn((dto: Partial<Alert>) => dto),
      save: jest.fn((dto: Partial<Alert>) =>
        Promise.resolve(asAlert({ id: 'uuid-1', ...dto })),
      ),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => updateQb),
    };
    mockNotification = { sendAlertEmail: jest.fn<Promise<void>, EmailArgs>() };
    returning();
    await build();
  });

  it('creates a new alert when no OPEN duplicate exists', async () => {
    mockRepo.findOne.mockResolvedValue(null);

    const result = await service.createOrDedup({
      alertType: 'ML_ANOMALY',
      severity: 'WARNING',
      source: 'web-app',
      title: 'test',
    });

    expect(mockRepo.save).toHaveBeenCalled();
    expect(result).toHaveProperty('id');
  });

  it('dedups — returns existing OPEN alert instead of creating new', async () => {
    const existing = {
      id: 'existing-1',
      status: 'OPEN',
      alertType: 'ML_ANOMALY',
      source: 'web-app',
    };
    mockRepo.findOne.mockResolvedValue(existing);

    const result = await service.createOrDedup({
      alertType: 'ML_ANOMALY',
      severity: 'WARNING',
      source: 'web-app',
      title: 'test',
    });

    expect(mockRepo.save).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('sends email for CRITICAL severity', async () => {
    mockRepo.findOne.mockResolvedValue(null);

    await service.createOrDedup({
      alertType: 'RULE_MATCH',
      severity: 'CRITICAL',
      source: 'api-gw',
      title: 'SQL injection',
      detail: { rule_id: 31100 },
    });

    expect(mockNotification.sendAlertEmail).toHaveBeenCalledWith(
      'CRITICAL',
      'SQL injection',
      expect.any(String),
    );
  });

  it('does NOT send email for INFO severity', async () => {
    mockRepo.findOne.mockResolvedValue(null);

    await service.createOrDedup({
      alertType: 'ML_ANOMALY',
      severity: 'INFO',
      source: 'web-app',
      title: 'low sev',
    });

    expect(mockNotification.sendAlertEmail).not.toHaveBeenCalled();
  });

  // ---- dedup key ต้องแยกตาม rule ----
  // บั๊กที่คุม: key เดิมไม่มี rule_id → RULE_MATCH ที่ค้าง OPEN ของ host หนึ่งกลืนทุก rule
  // อื่นบน host เดียวกัน เจอจริง: 5715 (login สำเร็จหลัง brute force) หายเข้า 5710

  const bruteForce: Partial<Alert> = {
    alertType: 'RULE_MATCH',
    severity: 'CRITICAL',
    source: 'web-server-01',
    title: 'Multiple authentication failures (brute force)',
    detail: { rule_id: 5710 },
  };
  const loginAfterFailures: Partial<Alert> = {
    alertType: 'RULE_MATCH',
    severity: 'WARNING',
    source: 'web-server-01',
    title: 'Successful login after multiple failures',
    detail: { rule_id: 5715 },
  };

  it('looks up the OPEN duplicate by rule_id (from detail, as a string)', async () => {
    mockRepo.findOne.mockResolvedValue(null);

    await service.createOrDedup(bruteForce);

    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: {
        status: 'OPEN',
        alertType: 'RULE_MATCH',
        source: 'web-server-01',
        batchId: IsNull(),
        ruleId: '5710',
      },
    });
    expect(mockRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: '5710' }),
    );
  });

  it('a different rule on the same host is a NEW alert, not a repeat of the open one', async () => {
    // findOne ตอบตาม where จริง — มีแค่ 5710 ค้าง OPEN อยู่
    const open5710 = asAlert({ id: 'a-5710', ...bruteForce, ruleId: '5710' });
    mockRepo.findOne.mockImplementation(({ where }: FindOneArgs) =>
      Promise.resolve(where.ruleId === '5710' ? open5710 : null),
    );

    const result = await service.createOrDedup(loginAfterFailures);

    expect(mockRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: '5715', status: 'OPEN' }),
    );
    expect(result.id).not.toBe('a-5710');
    expect(updateQb.execute).not.toHaveBeenCalled();
  });

  it('alerts without a rule (ML_ANOMALY) dedup with rule_id IS NULL', async () => {
    mockRepo.findOne.mockResolvedValue(null);

    await service.createOrDedup({
      alertType: 'ML_ANOMALY',
      severity: 'WARNING',
      source: 'web-app',
      title: 'anomaly',
      detail: { rule_id: null, confidence: 0.9 },
    });

    expect(findOneWhere().ruleId).toEqual(IsNull());
  });

  // ---- เกิดซ้ำต้องนับ ไม่ใช่ทิ้งเงียบ ----

  it('a repeat of the same rule bumps occurrence_count in SQL and does not insert or email', async () => {
    const existing = asAlert({
      id: 'a-5710',
      ...bruteForce,
      occurrenceCount: 1,
    });
    mockRepo.findOne.mockResolvedValue(existing);

    const result = await service.createOrDedup(bruteForce);

    expect(updateQb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceCount: expect.any(Function) as unknown,
        lastSeenAt: expect.any(Function) as unknown,
      }),
    );
    // บวกฝั่ง DB — ถ้าอ่านค่ามา +1 ในแอป alert ที่มาพร้อมกันจะนับหาย
    expect(setValues().occurrenceCount()).toBe('occurrence_count + 1');
    expect(updateQb.where).toHaveBeenCalledWith('id = :id', { id: 'a-5710' });
    expect(result.occurrenceCount).toBe(2);
    expect(result.lastSeenAt).toEqual(new Date('2026-09-23T01:00:00.000Z'));
    expect(mockRepo.save).not.toHaveBeenCalled();
    expect(mockNotification.sendAlertEmail).not.toHaveBeenCalled();
  });

  it('losing the insert race (23505) counts as a repeat of the winner', async () => {
    const winner = asAlert({ id: 'winner', ...bruteForce, occurrenceCount: 1 });
    mockRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    mockRepo.save.mockRejectedValue({ code: '23505' });

    const result = await service.createOrDedup(bruteForce);

    expect(result.id).toBe('winner');
    expect(updateQb.where).toHaveBeenCalledWith('id = :id', { id: 'winner' });
    expect(mockNotification.sendAlertEmail).not.toHaveBeenCalled();
  });

  it('ignores occurrenceCount / lastSeenAt sent in the POST body', async () => {
    mockRepo.findOne.mockResolvedValue(null);

    await service.createOrDedup({
      ...bruteForce,
      occurrenceCount: 999,
      lastSeenAt: new Date('2000-01-01'),
    });

    expect(mockRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceCount: 1, lastSeenAt: undefined }),
    );
  });

  // ---- 1.2 เตือนซ้ำ + ขยับ severity ----

  it('a new CRITICAL alert records lastNotifiedAt; a WARNING one does not', async () => {
    mockRepo.findOne.mockResolvedValue(null);
    await service.createOrDedup(bruteForce);
    expect(savedAlert().lastNotifiedAt).toBeInstanceOf(Date);

    await service.createOrDedup(loginAfterFailures);
    expect(savedAlert(1).lastNotifiedAt).toBeNull();
  });

  it('re-sends the email when the UPDATE says it is time (notify_now), with repeat info', async () => {
    const existing = asAlert({
      id: 'a-5710',
      ...bruteForce,
      createdAt: new Date('2026-09-22T10:01:00.000Z'),
    });
    mockRepo.findOne.mockResolvedValue(existing);
    returning({ occurrence_count: 7, notify_now: true });

    await service.createOrDedup({
      ...bruteForce,
      detail: { rule_id: 5710, n: 7 },
    });

    expect(mockNotification.sendAlertEmail).toHaveBeenCalledWith(
      'CRITICAL',
      'Multiple authentication failures (brute force)',
      JSON.stringify({ rule_id: 5710, n: 7 }), // detail ของครั้งล่าสุด ไม่ใช่ครั้งแรก
      {
        occurrences: 7,
        firstSeen: new Date('2026-09-22T10:01:00.000Z'),
        lastSeen: new Date('2026-09-23T01:00:00.000Z'),
      },
    );
  });

  it('takes the escalated severity from the UPDATE (WARNING alert hit by a CRITICAL repeat)', async () => {
    const ml = {
      alertType: 'ML_ANOMALY',
      source: 'web-app',
      title: 'anomaly',
      detail: {},
    };
    mockRepo.findOne.mockResolvedValue(
      asAlert({
        id: 'ml-1',
        ...ml,
        severity: 'WARNING',
      }),
    );
    returning({ severity: 'CRITICAL', notify_now: true });

    const result = await service.createOrDedup({ ...ml, severity: 'CRITICAL' });

    expect(updateQb.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ incomingSeverity: 'CRITICAL' }),
    );
    expect(result.severity).toBe('CRITICAL');
    expect(emailArgs()[0]).toBe('CRITICAL');
  });

  it.each([
    [undefined, 60],
    ['', 60],
    ['abc', 60],
    ['-5', 60],
    ['15', 15],
    ['0', 0], // 0 = ไม่เตือนซ้ำ (เตือนเฉพาะครั้งแรก / ตอน severity ขยับถึงเกณฑ์)
  ])('ALERT_RENOTIFY_MINUTES=%p → %p minutes', async (value, expected) => {
    env.ALERT_RENOTIFY_MINUTES = value;
    await build();
    mockRepo.findOne.mockResolvedValue(asAlert({ id: 'a', ...bruteForce }));

    await service.createOrDedup(bruteForce);

    expect(updateQb.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ renotifyMinutes: expected }),
    );
  });
});
