#!/usr/bin/env node
// The pgapex command line (src/cli/main.ts), run with tsx like the server.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli/main.ts');
process.exitCode = await main(process.argv.slice(2));
