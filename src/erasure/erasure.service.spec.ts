import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { ErasureService } from './erasure.service';
import { AuditAccess } from '../audit/entities/audit-access.entity';

// mock fs ทั้ง module — กัน test เขียนไฟล์ erasure-log.json จริง
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '[]'),
  writeFileSync: jest.fn(),
}));

describe('ErasureService', () => {
  let service: ErasureService;
  let mockRepo: any;

  beforeEach(async () => {
    mockRepo = {
      find: jest.fn(),
      delete: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        ErasureService,
        { provide: getRepositoryToken(AuditAccess), useValue: mockRepo },
      ],
    }).compile();

    service = module.get(ErasureService);
  });

  it('throws NotFound when user has no records', async () => {
    mockRepo.find.mockResolvedValue([]);

    await expect(service.eraseUser('ghost-user', 'admin')).rejects.toThrow(
      NotFoundException,
    );
    expect(mockRepo.delete).not.toHaveBeenCalled();
  });

  it('erases records and returns tombstone with SHA-256 hash', async () => {
    mockRepo.find.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    mockRepo.delete.mockResolvedValue({ affected: 2 });

    const result: any = await service.eraseUser('user-123', 'admin-dpo');

    expect(mockRepo.delete).toHaveBeenCalledWith({ userId: 'user-123' });
    expect(result.tombstone).toMatchObject({
      userId: 'user-123',
      requestedBy: 'admin-dpo',
      recordsDeleted: 2,
    });
    expect(result.tombstone.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
