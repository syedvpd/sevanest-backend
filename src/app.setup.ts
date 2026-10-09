import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { createValidationPipe } from './common/pipes/validation.pipe';
import {
  REQUEST_ID_HEADER,
  requestContextMiddleware,
} from './common/request-context/request-context';
import { AppConfigService } from './config/app-config.service';

/**
 * HTTP-layer configuration shared by the real server and the e2e tests, so tests exercise the production setup.
 * API shape: /api/v1/... (URI versioning; breaking changes ship as /api/v2 alongside v1). Health probes live at
 * /health/* outside the versioned prefix.
 */
export function configureApp(app: NestExpressApplication, config: AppConfigService): void {
  if (config.trustProxyHops > 0) {
    app.set('trust proxy', config.trustProxyHops);
  }
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestContextMiddleware);

  if (config.corsOrigins.length > 0) {
    app.enableCors({ origin: config.corsOrigins, exposedHeaders: [REQUEST_ID_HEADER] });
  }

  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('SevaNest API')
        .setDescription('Backend API for the Customer app, Worker app and Admin portal.')
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
    // The bare service URL has no route of its own; send visitors to the interactive docs.
    const http = app.getHttpAdapter();
    http.get('/', (_req, res) => {
      http.redirect(res, 302, '/docs');
    });
  }
}
