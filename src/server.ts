import './env.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './automations.ts';

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3100), host: process.env.HOST ?? '127.0.0.1' });
// automations (AUTOMATIONS=off on servers that should not run them)
startScheduler();
