import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Erasure Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('DELETE /erasure/user/:userId should return 404 for unknown user', async () => {
    await request(app.getHttpServer())
      .delete('/erasure/user/unknown-user-id')
      .send({ requestedBy: 'test' })
      .expect(404);
  });
});
