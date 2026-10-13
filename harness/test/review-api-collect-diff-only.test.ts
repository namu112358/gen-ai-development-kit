// review-api の材料で、文書（review.config.json の claude.diffOnlyExtensions の拡張子）の変更ファイルの全文を入れないことを確かめる（Issue #990）：
// .md と .ts を変えた偽の PR で collectMaterial（review-api/src/collect.ts）が .md の中身を取得せず diffOnly の印を付け、
// buildReviewerMessages・buildRiskMessages（review-api/src/prompts.ts）の材料に .md の全文が入らず .ts の全文が入り、.md のパスと read_file を含む1行が入ること、
// diffOnlyExtensions が [] なら .md の全文が入り、拡張子は大文字小文字を区別せず末尾で当て、ディレクトリ名の .md には当たらないこと、
// loadReviewConfig（review-api/src/config.ts）が diffOnlyExtensions の型違いを claude.diffOnlyExtensions の誤りにすることを、外部 API を呼ばずに確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectMaterial } from '../../review-api/src/collect.ts';
import { loadReviewConfig, type ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { buildReviewerMessages, buildRiskMessages, type UserMessage } from '../../review-api/src/prompts.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const claudeConfig = (diffOnlyExtensions: string[]): Pick<ReviewConfig, 'claude'> => ({
  claude: {
    reviewModel: 'm',
    riskModel: 'm',
    effort: 'high',
    maxTokens: 1000,
    maxToolCalls: 10,
    maxDiffChars: 100000,
    maxFileChars: 100000,
    diffOnlyExtensions,
  },
});

const section = (path: string) =>
  [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-old', '+DIFF_LINE_MARK'];

// 変更ファイルのパス → head の全文（全文にだけ入る目印。diff には入らない）
const collect = async (files: Record<string, string>, diffOnlyExtensions: string[]) => {
  const calls: string[] = [];
  const diff = [...Object.keys(files).flatMap(section), ''].join('\n');
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.pathname + url.search);
    const p = url.pathname.replace('/repos/o/r', '');
    if (p === '/pulls/5') {
      return json({ number: 5, title: 't', body: '説明', state: 'open', draft: true, head: { ref: 'h', sha: HEAD }, base: { ref: 'main', sha: BASE }, user: null });
    }
    if (p === '/issues/5/comments') return json([]);
    if (p === `/compare/main...${HEAD}`) return new Response(diff);
    const file = p.startsWith('/contents/') ? files[decodeURIComponent(p.slice('/contents/'.length))] : undefined;
    if (file !== undefined && url.searchParams.get('ref') === HEAD) return new Response(file);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const gh = createGitHubClient({ token: 't', owner: 'o', repo: 'r', fetch });
  const material = await collectMaterial(gh, claudeConfig(diffOnlyExtensions), {
    owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: 'agent-harness[bot]', reviewLogin: 'review-api[bot]',
  });
  return { material, calls };
};

const texts = (messages: UserMessage[]): string[] => messages.flatMap((m) => m.content.map((b) => b.text));

const MD_FULL = 'MD_FULL_TEXT_MARK';
const TS_FULL = 'TS_FULL_TEXT_MARK';

test('.md と .ts を変えた PR で、.md は取得せず全文を入れず、.ts は全文を入れる。.md は省いたことと read_file を示す1行が入る', async () => {
  const { material, calls } = await collect({ 'docs/guide.md': MD_FULL, 'src/a.ts': TS_FULL }, ['.md', '.html']);

  assert.deepStrictEqual(material.files, [
    { path: 'docs/guide.md', content: '', truncated: false, diffOnly: true },
    { path: 'src/a.ts', content: TS_FULL, truncated: false },
  ]);
  assert.ok(!calls.some((c) => c.includes('/contents/') && c.includes('guide.md')), calls.join('\n'));
  assert.ok(material.diff.includes('docs/guide.md'), '.md の変更は diff に残る');

  for (const [name, messages] of [
    ['Reviewer', buildReviewerMessages(material)],
    ['Risk', buildRiskMessages(material)],
  ] as const) {
    const blocks = texts(messages);
    const all = blocks.join('\n');
    assert.ok(!all.includes(MD_FULL), `${name}: .md の全文が入っている`);
    assert.ok(all.includes(TS_FULL), `${name}: .ts の全文が無い`);
    const notes = blocks.flatMap((b) => b.split('\n')).filter((line) => line.includes('docs/guide.md') && line.includes('read_file'));
    assert.equal(notes.length, 1, `${name}: .md のパスと read_file を含む1行がちょうど1つ:\n${all}`);
  }
});

test('拡張子の当て方：[] なら .md も全文、大文字の .MD も当たる、.md のディレクトリの下の .ts は当たらない', async () => {
  const cases: [string, Record<string, string>, string[], string[]][] = [
    // [名前, 変更ファイル, diffOnlyExtensions, 全文を省くパス]
    ['diffOnlyExtensions が空', { 'docs/guide.md': MD_FULL, 'src/a.ts': TS_FULL }, [], []],
    ['大文字の拡張子', { 'docs/README.MD': MD_FULL, 'src/a.ts': TS_FULL }, ['.md'], ['docs/README.MD']],
    ['ディレクトリ名の .md', { 'docs.md/x.ts': TS_FULL }, ['.md'], []],
  ];
  for (const [name, files, exts, omitted] of cases) {
    const { material } = await collect(files, exts);
    for (const f of material.files) {
      const expectOmit = omitted.includes(f.path);
      assert.equal(f.diffOnly === true, expectOmit, `${name}: ${f.path} の diffOnly`);
      assert.equal(f.content, expectOmit ? '' : files[f.path], `${name}: ${f.path} の content`);
    }
    assert.deepStrictEqual(material.files.map((f) => f.path), Object.keys(files), name);
    const all = texts(buildReviewerMessages(material)).join('\n');
    for (const [path, full] of Object.entries(files)) {
      assert.equal(all.includes(full), !omitted.includes(path), `${name}: ${path} の全文の有無`);
    }
  }
});

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const readRaw = (): Record<string, any> => JSON.parse(readFileSync(configPath, 'utf8'));

test('review.config.json の diffOnlyExtensions は .md と .html', () => {
  assert.deepEqual(loadReviewConfig(readRaw()).claude.diffOnlyExtensions, ['.md', '.html']);
});

test('diffOnlyExtensions は空配列なら読め、欠け・型違い・. で始まらない要素は claude.diffOnlyExtensions の誤りになる', () => {
  const ok = structuredClone(readRaw());
  ok.claude.diffOnlyExtensions = [];
  assert.deepEqual(loadReviewConfig(ok).claude.diffOnlyExtensions, []);

  const broken: [string, (r: Record<string, any>) => void][] = [
    ['鍵の欠け', (r) => { delete r.claude.diffOnlyExtensions; }],
    ['文字列', (r) => { r.claude.diffOnlyExtensions = '.md'; }],
    ['文字列でない要素', (r) => { r.claude.diffOnlyExtensions = ['.md', 1]; }],
    ['. で始まらない要素', (r) => { r.claude.diffOnlyExtensions = ['md']; }],
    ['空文字の要素', (r) => { r.claude.diffOnlyExtensions = ['']; }],
  ];
  for (const [name, mutate] of broken) {
    const raw = structuredClone(readRaw());
    mutate(raw);
    assert.throws(
      () => loadReviewConfig(raw),
      (error: unknown) => error instanceof Error && error.message.includes('claude.diffOnlyExtensions'),
      name,
    );
  }
});
