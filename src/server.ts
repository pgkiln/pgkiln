import './env.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './automations.ts';
import { startWorkflowRunner } from './workflow.ts';
import { startProcessJobRunner } from './process-jobs.ts';
import { startPushListener } from './push.ts';
import { startMailListener } from './mail/mail.ts';
import { startEmbeddingRunner } from './vector.ts';
import { startWebRequestRunner } from './webrequests.ts';
import { startWebhookRunner } from './webhooks.ts';

// (NX-S3) a public installation never runs with a default password (the Docker image checks this too:
// scripts/docker-start.ts replaces admin / admin with PGKILN_ADMIN_PASSWORD)
{
  const { defaultPasswords, publicInstance } = await import('./instance-checks.ts');
  if (publicInstance()) {
    const weak = await defaultPasswords();
    if (weak.length) {
      console.error(`pgkiln: PUBLIC_URL (${process.env.PUBLIC_URL}) is a public address, and ${weak.join(', ')} still sign${weak.length === 1 ? 's' : ''} in with the default password ("admin" or the user name). Change ${weak.length === 1 ? 'it' : 'them'} first: pgkiln users password <name> --developer (or set PGKILN_ADMIN_PASSWORD with the Docker image), then start again.`);
      process.exit(1);
    }
  }
}

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3100), host: process.env.HOST ?? '127.0.0.1' });
// automations, workflows and background processes (AUTOMATIONS=off / WORKFLOWS=off / BACKGROUND_PROCESSES=off on servers that should not run them)
startScheduler();
await startWorkflowRunner();
await startProcessJobRunner();
await startPushListener();
await startMailListener();
// (sprint 177) the web request outbox: delivered when queued (NOTIFY), retried when due (off with AUTOMATIONS=off)
await startWebRequestRunner();
// (sprint 177) events received by webhook handlers: processed when they arrive (WEBHOOKS=off on servers that should not)
await startWebhookRunner();
// (sprint 136) rows queued for their embeddings (EMBEDDINGS=off on servers that should not embed)
startEmbeddingRunner();
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
