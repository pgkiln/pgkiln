// Sprint 145 (AP-11): AI services are Claude, OpenAI, Gemini or an
// OpenAI-compatible endpoint (src/ai/types.ts ProviderName). Texts that offer
// the user "Claude or OpenAI" — the builder, the guide, the website and the HR
// example — fell behind when Gemini and OpenAI-compatible services came in
// 0.52.0. This keeps them from coming back. Release history (the CHANGELOG,
// "Done in 0.28.0 (AI with Claude and OpenAI)" on the parity page) is exempt,
// and so are released migrations and the test mocks, which do mock exactly
// the two wire protocols (Claude's Messages API, OpenAI's Chat Completions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const STALE = /\b(Claude|Anthropic) (or|and) OpenAI\b(?!'s)|\bClaude \(Anthropic\) or OpenAI\b/;
const HISTORY = /\b(Done )?in 0\.28\.0\b|0\.28\.0: AI with/;

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(join(root, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(root, p)).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

test('no text offers only Claude or OpenAI as AI providers', () => {
  const checked = [
    ...files('src', /\.ts$/),
    ...files('public', /\.(js|css|html)$/),
    ...files('docs', /\.md$/),
    ...files('examples', /\.sql$/).filter((f) => !f.endsWith('hr_78_ai_provider_texts.sql')),
    'README.md',
    'website/.vitepress/theme/components/Landing.vue',
  ];
  const stale = checked.flatMap((f) =>
    readFileSync(join(root, f), 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
      .filter(({ line }) => STALE.test(line) && !HISTORY.test(line))
      .map(({ at }) => at));
  assert.deepEqual(stale, []);
});

test('the builder names every provider of src/ai/types.ts', () => {
  const types = readFileSync(join(root, 'src/ai/types.ts'), 'utf8');
  assert.match(types, /ProviderName = 'anthropic' \| 'openai' \| 'gemini' \| 'openai_compatible'/, 'a new provider: update this test and the texts');
  for (const f of ['src/builder/home.ts', 'src/builder/assistant.ts']) {
    const s = readFileSync(join(root, f), 'utf8');
    for (const name of ['Claude', 'OpenAI', 'Gemini', 'OpenAI-compatible']) assert.ok(s.includes(name), `${f} names ${name}`);
  }
});
