import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

const chapters: { link: string; text: string }[] = JSON.parse(readFileSync(new URL('../docs/sidebar.json', import.meta.url), 'utf8'));
const version: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const chapter = (slug: string) => chapters.find((c) => c.link === `/docs/${slug}`)!;
const group = (text: string, slugs: string[]) => ({ text, collapsed: false, items: slugs.map(chapter) });

export default defineConfig({
  title: 'pgkiln',
  description: 'Open source low-code application builder for PostgreSQL. Build data-driven web apps in SQL, an alternative to Oracle APEX.',
  lang: 'en',
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ['scripts/**', 'README.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#c2410c' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'pgkiln: build PostgreSQL apps in SQL' }],
    ['meta', { property: 'og:description', content: 'Open source low-code application builder for PostgreSQL, an alternative to Oracle APEX.' }],
    ['meta', { property: 'og:image', content: 'https://pgkiln.vargar.eu/images/builder-page-designer.png' }],
    ['meta', { property: 'og:url', content: 'https://pgkiln.vargar.eu/' }],
  ],
  sitemap: { hostname: 'https://pgkiln.vargar.eu' },
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    siteTitle: 'pgkiln',
    nav: [
      { text: 'Features', link: '/#features' },
      { text: 'Docs', link: '/docs/installation', activeMatch: '^/docs/' },
      { text: 'Tutorial', link: '/docs/tutorial' },
      { text: 'Coming from APEX', link: '/docs/from-apex' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: 'https://github.com/pgkiln/pgkiln/blob/main/CHANGELOG.md' },
          { text: 'Security model', link: '/docs/security-model' },
          { text: 'APEX feature parity', link: '/docs/apex-parity' },
          { text: 'Contributing', link: 'https://github.com/pgkiln/pgkiln/blob/main/CONTRIBUTING.md' },
        ],
      },
    ],
    sidebar: {
      '/docs/': [
        { text: 'Overview', items: [{ text: 'The user guide', link: '/docs/' }] },
        group('Getting started', ['installation', 'concepts', 'tutorial', 'from-apex']),
        group('Building applications', ['builder', 'pages-and-regions', 'items', 'processing', 'dynamic-actions', 'globalization', 'files', 'mobile']),
        group('Security and data', ['security', 'rest-api', 'rest-data-sources', 'extensions']),
        group('Tools and reference', ['cli', 'ai-agents', 'reference', 'development']),
        {
          text: 'More',
          items: [
            { text: 'Security model and review', link: '/docs/security-model' },
            { text: 'Oracle APEX feature parity', link: '/docs/apex-parity' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/pgkiln/pgkiln' }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    editLink: {
      // the pages are generated from ../docs; this points at the guide's folder
      pattern: 'https://github.com/pgkiln/pgkiln/tree/main/docs/guide',
      text: 'Improve the guide on GitHub',
    },
    footer: {
      message: 'Released under the Apache-2.0 license. Not affiliated with Oracle; Oracle and APEX are trademarks of Oracle.',
      copyright: `© ${new Date().getFullYear()} Vargar`,
    },
  },
});
