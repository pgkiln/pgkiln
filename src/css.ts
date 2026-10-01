import { createHash } from 'node:crypto';

// Per-page styles that depend on data (chart bar widths and positions).
// The Content-Security-Policy allows no inline style attributes, so each
// declaration becomes a class in one <style> block that carries the
// response's nonce. Class names are a hash of the declaration, so equal
// declarations share a class and refreshed regions can add their rules to
// the page (app.js inserts them through the CSSOM).

export class PageCss {
  private rules = new Map<string, string>();

  /** A class for these declarations, e.g. cls('width:34.000%'). Only server-made declarations go here. */
  cls(declarations: string) {
    if (/[{}<>]/.test(declarations)) throw new Error('Invalid CSS declaration');
    const name = `x${createHash('sha256').update(declarations).digest('base64url').slice(0, 10).replace(/[-_]/g, 'z')}`;
    this.rules.set(name, declarations);
    return name;
  }

  get size() {
    return this.rules.size;
  }

  /** The rules, one per line (also sent with a refreshed region). */
  get text() {
    return [...this.rules].map(([name, d]) => `.${name}{${d}}`).join('\n');
  }
}
