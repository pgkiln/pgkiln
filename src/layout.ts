import { html, type Raw } from './html.ts';

/** Attributes of <html>: language, text direction and a fixed theme (light/dark; absent = follow the OS). */
export interface RootAttrs {
  lang?: string;
  dir?: 'ltr' | 'rtl';
  theme?: 'auto' | 'light' | 'dark';
}

export function documentShell(title: string, body: Raw, bodyClass = '', data: Record<string, string> = {}, head: Raw | '' = '', root: RootAttrs = {}) {
  const attrs = Object.entries(data).map(([k, v]) => html` ${k}="${v}"`);
  return html`<!doctype html>
<html lang="${root.lang ?? 'en'}"${root.dir === 'rtl' ? html` dir="rtl"` : ''}${root.theme && root.theme !== 'auto' ? html` data-theme="${root.theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
${head}
</head>
<body class="${bodyClass}"${attrs}>
${body}
</body>
</html>`.value;
}
