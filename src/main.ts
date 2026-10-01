import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { installUnhandledRejectionGuard } from './common/process/unhandled-rejection';
import { MetricsService } from './metrics/metrics.service';
import { startMetricsServer } from './metrics/metrics-server';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // ติดก่อน create — BlockchainService.onModuleInit คุยกับ RPC ระหว่าง create
  // metrics ยังไม่มีในช่วงนั้น: นับได้หลัง app พร้อมแล้วเท่านั้น (log ERROR ได้เสมอ)
  const ref: { metrics?: MetricsService } = {};
  installUnhandledRejectionGuard((code) =>
    ref.metrics?.incrementUnhandledEthersRejection(code),
  );

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // ข้างหน้ามี proxy 1 ชั้น (Caddy https-proxy) — ไม่ตั้ง = rate limit นับทุกเครื่องเป็น IP ของ Caddy
  // Caddy เขียน X-Forwarded-For ใหม่เอง (ไม่เชื่อค่าที่ client ส่งมา) · :3000 ตรง bind 127.0.0.1 เสมอ
  // บน cloud มี Cloudflare Tunnel อยู่หน้า Caddy อีกชั้น แต่ Caddy แทน XFF ด้วย Cf-Connecting-IP แล้ว
  // (infra/caddy/Caddyfile.cloud) → จากมุม backend ยังเป็น 1 ชั้น ห้ามเพิ่มเป็น 2
  app.set('trust proxy', 1);
  const metrics = app.get(MetricsService);
  ref.metrics = metrics;
  // /metrics ไม่อยู่บน :3000 แล้ว — port แยกที่ไม่ publish ออก host (review B5)
  startMetricsServer(metrics);

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // log error เต็มๆ ลง console (debug ง่ายขึ้น)
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [
      'http://localhost:3001',
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('LogChain')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, config),
    );

    logger.log('Swagger: http://localhost:3000/api/docs');
  }

  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`API Gateway running on :${port}`);
}
void bootstrap();
