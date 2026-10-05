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
import { lockRoutes } from './builder/locks.ts';
import { supportingRoutes } from './builder/supporting.ts';
import { sharedRoutes } from './builder/shared.ts';
import { webSourceRoutes } from './builder/websources.ts';
import { sqlRoutes } from './builder/sql.ts';
import { automationRoutes } from './builder/automations.ts';
import { workflowBuilderRoutes } from './builder/workflows.ts';
import { regionSettingsRoutes } from './builder/region-settings.ts';
import { templateRoutes } from './builder/templates.ts';
import { searchRoutes } from './builder/search.ts';
import { advisorRoutes } from './builder/advisor.ts';
import { topSqlRoutes } from './builder/top-sql.ts';
import { ldapRoutes } from './builder/ldap.ts';
import { documentRoutes } from './builder/documents.ts';
import { pwaBuilderRoutes } from './builder/pwa.ts';
import { reportSettingsRoutes } from './builder/report-settings.ts';
import { layoutRoutes } from './builder/layouts.ts';
import { dataLoadRoutes } from './builder/dataload.ts';
import { builderRoutes } from './builder/routes.ts';
import { usersRoutes } from './builder/users.ts';
import { codeEditorRoutes } from './builder/code-editor.ts';
import { accountRoutes } from './runtime/account.ts';
import { taskRoutes } from './runtime/tasks.ts';
import { workflowRoutes } from './runtime/workflows.ts';
import { pwaRoutes } from './runtime/pwa.ts';
import { restRoutes } from './runtime/rest.ts';
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
  // An id in the URL that isn't a number (or is too big) fails in PostgreSQL:
  // that's a page that doesn't exist, not a server error.
  app.setErrorHandler((err: Error & { code?: string }, _req, reply) => {
    if (err.code === '22P02' || err.code === '22003') return reply.code(404).type('text/plain').send('Not found');
    return reply.send(err);
  });
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 5 * 1024 * 1024 });
  // file upload items; oversized files are cut off and reported, not thrown
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20, fields: 2000, fieldSize: 1024 * 1024, parts: 2100 },
  });
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/static/' });
  // Leaflet for map regions (BSD-2-Clause), served from the package itself
  await app.register(fastifyStatic, { root: join(root, 'node_modules', 'leaflet', 'dist'), prefix: '/static/vendor/leaflet/', decorateReply: false });
  await app.register(runtimeRoutes);
  await app.register(accountRoutes);
  await app.register(taskRoutes);
  await app.register(workflowRoutes);
  await app.register(pwaRoutes);
  await app.register(restRoutes);
  await app.register(builderRoutes);
  await app.register(sharedRoutes);
  await app.register(designerRoutes);
  await app.register(lockRoutes);
  await app.register(supportingRoutes);
  await app.register(sqlRoutes);
  await app.register(usersRoutes);
  await app.register(dataLoadRoutes);
  await app.register(layoutRoutes);
  await app.register(automationRoutes);
  await app.register(workflowBuilderRoutes);
  await app.register(reportSettingsRoutes);
  await app.register(regionSettingsRoutes);
  await app.register(templateRoutes);
  await app.register(webSourceRoutes);
  await app.register(searchRoutes);
  await app.register(advisorRoutes);
  await app.register(topSqlRoutes);
  await app.register(ldapRoutes);
  await app.register(documentRoutes);
  await app.register(pwaBuilderRoutes);
  await app.register(oauthRoutes);
  await app.register(apiRoutes);
  await app.register(globalizationRoutes);
  await app.register(codeEditorRoutes);
  app.get('/', async (_req, reply) => reply.redirect('/builder'));
  return app;
}
