require('reflect-metadata');
require('dotenv').config();

const { NestFactory }         = require('@nestjs/core');
const { AppModule }           = require('./app.module');
const { HttpExceptionFilter } = require('./common/filters/http-exception.filter');
const { LoggingInterceptor } = require('./common/interceptors/logging.interceptor');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Time-Off Service running on http://localhost:${port}`);
}

bootstrap();