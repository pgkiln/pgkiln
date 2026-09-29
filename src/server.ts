import './env.ts';
import { buildApp } from './app.ts';

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3100), host: process.env.HOST ?? '127.0.0.1' });
