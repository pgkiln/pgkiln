import { html, type Raw } from './html.ts';

export function documentShell(title: string, body: Raw, bodyClass = '', data: Record<string, string> = {}) {
  const attrs = Object.entries(data).map(([k, v]) => html` ${k}="${v}"`);
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body class="${bodyClass}"${attrs}>
${body}
</body>
</html>`.value;
}
