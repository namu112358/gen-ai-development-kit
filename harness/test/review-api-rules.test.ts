// review-api のリポジトリの規則集め（review-api/src/rules.ts の collectRules）が、偽の GitHub（getFileContent だけ）に対して、
// base の SHA の CLAUDE.md・AGENTS.md と @ の先（相対・入れ子・循環は1回）だけを読み head を読まないこと、
// 根の外・絶対パス・~・バックスラッシュ・秘密のパス・深さの上限・404 の先を読まず skipped に理由を入れること、
// 文字数・ファイル数の上限で too-large、404 以外の失敗で unreadable、入口が両方無ければ none、
// フェンス・インラインコード・空白の直後でない @ を読まないことを確かめる（Issue #1051）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRules } from '../../review-api/src/rules.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);

// ref ごとのファイルの表。表に無いものは 404（null）、fail のパスは 404 以外の失敗で投げる
function fakeGitHub(tables: Record<string, Record<string, string>>, fail?: string) {
  const calls: { path: string; ref: string }[] = [];
  return {
    calls,
    read: () => calls.map((c) => c.path),
    async getFileContent(path: string, ref: string): Promise<string | null> {
      calls.push({ path, ref });
      if (path === fail) throw new Error('GitHub 500');
      return tables[ref]?.[path] ?? null;
    },
  };
}

const byPath = <T extends { path: string }>(xs: T[]) => [...xs].sort((a, b) => a.path.localeCompare(b.path));

test('base の CLAUDE.md・AGENTS.md と @ の先（相対・入れ子）を読み、head にだけある内容は入らない。循環は1回だけ読む', async () => {
  const base = {
    'CLAUDE.md': '規則A\n@docs/a.md\n',
    'AGENTS.md': '規則B',
    'docs/a.md': 'A\n@sub/b.md',
    'docs/sub/b.md': 'B\n@../../CLAUDE.md',
  };
  const gh = fakeGitHub({ [BASE]: base, [HEAD]: { 'CLAUDE.md': 'HEAD だけ\n@head.md', 'head.md': 'H' } });
  const r = await collectRules(gh, BASE);
  assert.equal(r.status, 'ok');
  assert.deepEqual(byPath(r.files), byPath(Object.entries(base).map(([path, content]) => ({ path, content }))));
  assert.equal(r.chars, Object.values(base).join('').length);
  assert.deepEqual(r.skipped, []);
  assert.ok(gh.calls.every((c) => c.ref === BASE));
  assert.equal(gh.read().filter((p) => p === 'CLAUDE.md').length, 1);
});

test('根の外・絶対パス・~・バックスラッシュ・秘密のパス・深さの上限・404 の先は読まず、skipped に理由が入る', async () => {
  const gh = fakeGitHub({
    [BASE]: {
      'CLAUDE.md': '@../x.md @/etc/passwd @~/secret.md @docs\\a.md @.env @missing.md @d1.md',
      'docs/a.md': 'x', '.env': 'SECRET=1',
      'd1.md': '@d2.md', 'd2.md': '@d3.md', 'd3.md': '@d4.md', 'd4.md': '深すぎる',
    },
  });
  const r = await collectRules(gh, BASE);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['CLAUDE.md', 'd1.md', 'd2.md', 'd3.md']);
  assert.deepEqual(byPath(r.skipped), byPath([
    { path: '../x.md', reason: 'outside' },
    { path: '/etc/passwd', reason: 'outside' },
    { path: '~/secret.md', reason: 'outside' },
    { path: 'docs\\a.md', reason: 'outside' },
    { path: '.env', reason: 'secret' },
    { path: 'missing.md', reason: 'missing' },
    { path: 'd4.md', reason: 'depth' },
  ]));
  assert.deepEqual(gh.read().sort(), ['AGENTS.md', 'CLAUDE.md', 'd1.md', 'd2.md', 'd3.md', 'missing.md']);
});

test('フェンス・インラインコードの中の @ と、空白の直後でない @ は読まない', async () => {
  const claude = [
    '````md', '@fenced1.md', '```', '@fenced2.md', '````',
    '~~~', '@tilde.md', '~~~',
    '`@inline.md` と書く。連絡は user@example.com',
    '@real.md',
  ].join('\n');
  const names = ['fenced1.md', 'fenced2.md', 'tilde.md', 'inline.md', 'example.com', 'real.md'];
  const gh = fakeGitHub({ [BASE]: { 'CLAUDE.md': claude, ...Object.fromEntries(names.map((n) => [n, n])) } });
  const r = await collectRules(gh, BASE);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['CLAUDE.md', 'real.md']);
  assert.deepEqual(gh.read().sort(), ['AGENTS.md', 'CLAUDE.md', 'real.md']);
});

test('上限を超えると too-large、404 以外の失敗で unreadable（files は空・chars は 0）、入口が両方無ければ none', async () => {
  // CLAUDE.md（5字）＋ a.md（4字）＝ 2ファイル・9字
  const small = { 'CLAUDE.md': '@a.md', 'a.md': 'aaaa' };
  const cases = [
    { name: '文字数がちょうど上限', limits: { maxChars: 9 }, status: 'ok' },
    { name: '文字数が上限を超える', limits: { maxChars: 8 }, status: 'too-large' },
    { name: 'ファイル数がちょうど上限', limits: { maxFiles: 2 }, status: 'ok' },
    { name: 'ファイル数が上限を超える', limits: { maxFiles: 1 }, status: 'too-large' },
  ] as const;
  for (const c of cases) {
    const r = await collectRules(fakeGitHub({ [BASE]: small }), BASE, c.limits);
    assert.equal(r.status, c.status, c.name);
    if (c.status === 'too-large') assert.deepEqual([r.files, r.chars], [[], 0], c.name);
    else assert.equal(r.files.length, 2, c.name);
  }

  const unreadable = await collectRules(fakeGitHub({ [BASE]: small }, 'a.md'), BASE);
  assert.deepEqual([unreadable.status, unreadable.files, unreadable.chars], ['unreadable', [], 0]);

  const none = await collectRules(fakeGitHub({ [BASE]: {}, [HEAD]: small }), BASE);
  assert.deepEqual([none.status, none.files, none.chars, none.skipped], ['none', [], 0, []]);
});
