import './env.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './automations.ts';
import { startWorkflowRunner } from './workflow.ts';
import { startProcessJobRunner } from './process-jobs.ts';
import { startPushListener } from './push.ts';
import { startMailListener } from './mail/mail.ts';

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3100), host: process.env.HOST ?? '127.0.0.1' });
// automations, workflows and background processes (AUTOMATIONS=off / WORKFLOWS=off / BACKGROUND_PROCESSES=off on servers that should not run them)
startScheduler();
await startWorkflowRunner();
await startProcessJobRunner();
await startPushListener();
await startMailListener();
// (sprint 133, SEC-6) say at start-up what could lock people out: a changed instance key or address, the clock
try {
  const { instanceChecks } = await import('./instance-checks.ts');
  const { rpIdOf } = await import('./webauthn.ts');
  const pub = process.env.PUBLIC_URL;
  for (const c of await instanceChecks(pub && URL.canParse(pub) ? rpIdOf(new URL(pub).origin) : null))
    if (c.level === 'error' || (c.level === 'warning' && c.key !== 'key_backup')) console.warn(`pgkiln: ${c.title}: ${c.detail}`);
} catch (e) {
  console.warn('pgkiln: lockout checks failed:', (e as Error).message);
}
