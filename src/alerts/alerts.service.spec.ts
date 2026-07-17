import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { NotificationService } from '../notification/notification.service';

describe('AlertsService', () => {
  let service: AlertsService;
  let mockRepo: any;
  let mockNotification: any;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      create: jest.fn((dto) => dto),
      save: jest.fn((dto) => Promise.resolve({ id: 'uuid-1', ...dto })),
      find: jest.fn(),
    };
    mockNotification = { sendAlertEmail: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: getRepositoryToken(Alert), useValue: mockRepo },
        { provide: NotificationService, useValue: mockNotification },
      ],
    }).compile();

    service = module.get(AlertsService);
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
});
