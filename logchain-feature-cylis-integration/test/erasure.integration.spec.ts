import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';

describe('Erasure Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = {
            sub: 'e2e-test-user',
            preferred_username: 'e2e',
            roles: ['admin'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: () => true,
      })
      .overrideProvider(KafkaProducerService)
      .useValue({ publishLog: async () => undefined })
      .overrideProvider(KafkaConsumerService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('DELETE /erasure/user/:userId should return 404 for unknown user', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/erasure/user/unknown-user-id')
      .send({ requestedBy: 'test' })
      .expect(404);
  });
});
