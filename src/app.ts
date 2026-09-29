import { root } from './env.ts';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { apiRoutes } from './builder/api.ts';
import { globalizationRoutes } from './builder/globalization.ts';
import { mailRoutes } from './builder/mail.ts';
import { builderRoutes } from './builder/routes.ts';
import { usersRoutes } from './builder/users.ts';
import { accountRoutes } from './runtime/account.ts';
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
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/static/' });
  await app.register(runtimeRoutes);
  await app.register(accountRoutes);
  await app.register(builderRoutes);
  await app.register(usersRoutes);
  await app.register(apiRoutes);
  await app.register(mailRoutes);
  await app.register(globalizationRoutes);
  app.get('/', async (_req, reply) => reply.redirect('/builder'));
  return app;
}
