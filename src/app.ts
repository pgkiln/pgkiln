import { root } from './env.ts';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { apiRoutes } from './builder/api.ts';
import { globalizationRoutes } from './builder/globalization.ts';
import { designerRoutes } from './builder/designer.ts';
import { sharedRoutes } from './builder/shared.ts';
import { sqlRoutes } from './builder/sql.ts';
import { automationRoutes } from './builder/automations.ts';
import { reportSettingsRoutes } from './builder/report-settings.ts';
import { layoutRoutes } from './builder/layouts.ts';
import { dataLoadRoutes } from './builder/dataload.ts';
import { builderRoutes } from './builder/routes.ts';
import { usersRoutes } from './builder/users.ts';
import { accountRoutes } from './runtime/account.ts';
import { oauthRoutes } from './oauth.ts';
import { MAX_UPLOAD_MB } from './runtime/files.ts';
import { runtimeRoutes } from './runtime/routes.ts';
import { loadSecrets, securityHeaders } from './security.ts';

export async function buildApp(opts: { logger?: boolean } = {}) {
  await loadSecrets();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // behind a reverse proxy, set TRUST_PROXY=true so req.ip is the client (login throttling)
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  securityHeaders(app);
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 5 * 1024 * 1024 });
  // file upload items; oversized files are cut off and reported, not thrown
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20, fields: 2000, fieldSize: 1024 * 1024, parts: 2100 },
  });
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/static/' });
  await app.register(runtimeRoutes);
  await app.register(accountRoutes);
  await app.register(builderRoutes);
  await app.register(sharedRoutes);
  await app.register(designerRoutes);
  await app.register(sqlRoutes);
  await app.register(usersRoutes);
  await app.register(dataLoadRoutes);
  await app.register(layoutRoutes);
  await app.register(automationRoutes);
  await app.register(reportSettingsRoutes);
  await app.register(oauthRoutes);
  await app.register(apiRoutes);
  await app.register(globalizationRoutes);
  app.get('/', async (_req, reply) => reply.redirect('/builder'));
  return app;
}
