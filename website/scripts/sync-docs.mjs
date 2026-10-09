// Copies the user guide (../docs, ../SECURITY.md) into website/docs/ for VitePress:
// chapter files lose their number (01-installation.md → installation.md), links are
// rewritten to the new names, links outside the guide point to GitHub, and raw "<"
// that is not one of the few HTML tags the guide uses is escaped (Vue would read it).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');
const out = join(site, 'docs');
const GITHUB = 'https://github.com/pgkiln/pgkiln/blob/main';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const chapters = readdirSync(join(repo, 'docs/guide')).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const slug = (f) => f.replace(/^\d\d-/, '').replace(/\.md$/, '');
const pages = [
  ...chapters.map((f) => ({ src: `docs/guide/${f}`, dst: `${slug(f)}.md` })),
  { src: 'docs/README.md', dst: 'index.md' },
  { src: 'docs/apex-feature-parity.md', dst: 'apex-parity.md' },
  { src: 'SECURITY.md', dst: 'security-model.md' },
];
// repo path → page in the site
const target = new Map(pages.map((p) => [p.src, p.dst.replace(/\.md$/, '')]));

const ALLOWED_TAGS = /^<\/?(kbd|a|br|details|summary|sub|sup|img|p|b|i|em|strong|code)(\s|>|\/)/i;

function rewriteLink(href, from) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash] = href.split('#');
  // resolve against the source file's directory
  const parts = [...dirname(from).split('/'), ...path.split('/')];
  const stack = [];
  for (const p of parts) p === '..' ? stack.pop() : p && p !== '.' && stack.push(p);
  const resolved = stack.join('/');
  const page = target.get(resolved);
  if (page) return `./${page === 'index' ? '' : page}${hash ? '#' + hash : ''}`;
  return `${GITHUB}/${resolved}${hash ? '#' + hash : ''}`;
}

function escapeOutsideCode(md) {
  const out = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(line); continue; }
    if (fence) { out.push(line); continue; }
    // split on inline code spans, escape only outside them
    out.push(line.split(/(`+[^`]*`+)/).map((seg, i) => {
      if (i % 2) return seg;
      return seg.replace(/<(?!\/?[A-Za-z])/g, '&lt;').replace(/<[^>]*>?/g, (tag) => (ALLOWED_TAGS.test(tag) ? tag : tag.replace(/</g, '&lt;')))
        ;
    }).join(''));
  }
  return out.join('\n');
}

for (const p of pages) {
  let md = readFileSync(join(repo, p.src), 'utf8');
  md = md.replace(/\]\(([^)\s]+)\)/g, (_, href) => `](${rewriteLink(href, p.src)})`);
  md = escapeOutsideCode(md);
  // the numbered title "# 3. Using the builder" reads better without the number on the web
  md = md.replace(/^# \d+\.\s+/, '# ');
  // no Vue templating in the guide: {{…}} in document-template examples stays text
  writeFileSync(join(out, p.dst), `::: v-pre\n\n${md}\n\n:::\n`);
}

if (existsSync(join(repo, 'docs/images'))) cpSync(join(repo, 'docs/images'), join(site, 'public/images'), { recursive: true });
// the sidebar, in the guide's order, for config.mts
const titles = chapters.map((f) => ({ link: `/docs/${slug(f)}`, text: readFileSync(join(repo, 'docs/guide', f), 'utf8').match(/^# (?:\d+\.\s+)?(.*)$/m)[1] }));
writeFileSync(join(out, 'sidebar.json'), JSON.stringify(titles, null, 2) + '\n');
console.log(`synced ${pages.length} pages into website/docs/`);
