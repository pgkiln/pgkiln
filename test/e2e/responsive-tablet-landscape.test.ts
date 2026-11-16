// The responsive tests (test/e2e/responsive.ts) at the tablet-landscape width. One file per width,
// so the shards of CI's e2e job run the widths in parallel.
import { viewportTests } from './responsive.ts';

viewportTests('tablet-landscape');
