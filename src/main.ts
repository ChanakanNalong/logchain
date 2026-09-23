import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { installUnhandledRejectionGuard } from './common/process/unhandled-rejection';
import { MetricsService } from './metrics/metrics.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // ติดก่อน create — BlockchainService.onModuleInit คุยกับ RPC ระหว่าง create
  // metrics ยังไม่มีในช่วงนั้น: นับได้หลัง app พร้อมแล้วเท่านั้น (log ERROR ได้เสมอ)
  const ref: { metrics?: MetricsService } = {};
  installUnhandledRejectionGuard((code) =>
    ref.metrics?.incrementUnhandledEthersRejection(code),
  );

  const app = await NestFactory.create(AppModule);
  ref.metrics = app.get(MetricsService);

  app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });

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
