// Issue #328：arch-review を /loop から回し、前回の位置から続けて見直す。
// 記録の書式（trigger・下書きの body・採用数）、下書きの採用（arch-review-adopt）、採用待ちの一覧（arch-review-pending）、
// /loop の下書きの上限、skill・docs の /loop での回し方の検査
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ARCH_REVIEW_COMMENT_MAX,
  ARCH_REVIEW_LOOP_MAX_DRAFTS,
  adoptArchReviewDraft,
  archReviewAdoption,
  archReviewBodyErrors,
  checkArchReviewRecord,
  checkIssueDrafts,
  latestArchReviewRecord,
  parseArchReviewRecord,
  renderArchReviewRecord,
  type ArchReviewRecord,
} from '../lib/arch-review.ts';
import { claudeMark } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import { documentedAgentCommands } from './support/agent-source.ts';
import { APP, config } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const SESSION = 'https://claude.ai/code/session_01ARCHLOOPxxxxxxxxxxxxxxxx';
const PREV = 'c'.repeat(40);
const TIP = 'd'.repeat(40);
const OLDER = 'e'.repeat(40);

/** Issue Form の見出しをすべて持つ下書きの本文 */
const DRAFT_BODY = [
  '### Goal', '', '着手宣言の読み取りを1か所にする', '',
  '### Background', '', '読み取りが2か所にある', '',
  '### Requirements', '', '- claimOf を使う', '',
  '### Non-goals', '', '- 書式は変えない', '',
  '### Acceptance Criteria', '', '- [ ] 重複が無い', '',
  '### Dependencies', '', 'なし', '',
  '### Validation Requirements', '', '`npm run check`',
].join('\n');

const loopRecord = (patch: Partial<ArchReviewRecord> = {}): ArchReviewRecord => ({
  version: 1,
  trigger: 'loop',
  baseSha: PREV,
  headSha: TIP,
  prs: [301, 302],
  summary: ['着手宣言の読み取りが2か所にある'],
  drafts: [
    { title: 'refactor(harness): 着手宣言の読み取りを1か所にする', body: DRAFT_BODY, created: null },
    { title: 'docs: formats.md の着手宣言の節を直す', body: DRAFT_BODY, created: null, duplicateOf: 123 },
    { title: 'fix(harness): 採用済みの下書き', body: DRAFT_BODY, created: 250 },
  ],
  ...patch,
});

let nextId = 1000;
function comment(body: string, patch: Partial<IssueComment> = {}): IssueComment {
  const id = nextId++;
  return {
    id, body, html_url: `c${id}`, created_at: new Date(Date.UTC(2026, 8, 1) + id * 60_000).toISOString(), updated_at: '',
    author_association: 'OWNER', user: { login: 'me', type: 'User' }, ...patch,
  } as IssueComment;
}
const recordComment = (r: ArchReviewRecord, patch: Partial<IssueComment> = {}, session: string | null = SESSION) =>
  comment(renderArchReviewRecord(r, session), patch);

// ---- 定数 ----

test('ARCH_REVIEW_LOOP_MAX_DRAFTS は 3、ARCH_REVIEW_COMMENT_MAX は 65536', () => {
  assert.equal(ARCH_REVIEW_LOOP_MAX_DRAFTS, 3);
  assert.equal(ARCH_REVIEW_COMMENT_MAX, 65536);
});

// ---- checkArchReviewRecord（trigger・body・duplicateOf・commented） ----

test('checkArchReviewRecord：trigger が loop・manual・無しなら通り、それ以外は誤り', () => {
  assert.ok(checkArchReviewRecord(loopRecord()).ok);
  assert.ok(checkArchReviewRecord(loopRecord({ trigger: 'manual' })).ok);
  const { trigger: _t, ...noTrigger } = loopRecord();
  assert.ok(checkArchReviewRecord(noTrigger).ok, 'trigger の無い記録は通る');
  for (const trigger of ['cron', '', 1, 'LOOP']) {
    assert.equal(checkArchReviewRecord({ ...loopRecord(), trigger }).ok, false, `trigger=${JSON.stringify(trigger)}`);
  }
});

test('checkArchReviewRecord：trigger の無い古い記録（body・duplicateOf・commented の無い下書き、4件以上）は今までどおり通る', () => {
  const old = {
    version: 1, baseSha: null, headSha: PREV, prs: [157], summary: [],
    drafts: [1, 2, 3, 4].map((i) => ({ title: `docs: 古い下書き ${i}`, created: i === 1 ? 201 : null })),
  };
  const r = checkArchReviewRecord(old);
  assert.ok(r.ok, JSON.stringify(r));
});

test('checkArchReviewRecord：下書きの body は文字列、duplicateOf は正の整数、commented は正の整数か null', () => {
  const withDraft = (d: Record<string, unknown>) => ({ ...loopRecord({ trigger: 'manual' }), drafts: [{ title: 'docs: a', created: null, ...d }] });
  assert.ok(checkArchReviewRecord(withDraft({ body: DRAFT_BODY, duplicateOf: 5, commented: null })).ok);
  assert.ok(checkArchReviewRecord(withDraft({ commented: 5, duplicateOf: 5 })).ok);
  assert.ok(checkArchReviewRecord(withDraft({})).ok, 'どれも任意');
  for (const bad of [{ body: 1 }, { body: null }, { duplicateOf: 0 }, { duplicateOf: -1 }, { duplicateOf: 1.5 }, { duplicateOf: '5' }, { commented: 0 }, { commented: '5' }, { commented: 2.5 }]) {
    assert.equal(checkArchReviewRecord(withDraft(bad)).ok, false, JSON.stringify(bad));
  }
});

test('checkArchReviewRecord：trigger が loop なら下書きは3件以下で、すべてに body（文字列）がある', () => {
  const four = loopRecord({ drafts: [1, 2, 3, 4].map((i) => ({ title: `docs: 下書き ${i}`, body: DRAFT_BODY, created: null })) });
  assert.equal(checkArchReviewRecord(four).ok, false, 'loop で4件は誤り');
  const three = loopRecord({ drafts: [1, 2, 3].map((i) => ({ title: `docs: 下書き ${i}`, body: DRAFT_BODY, created: null })) });
  assert.ok(checkArchReviewRecord(three).ok, 'loop で3件は通る');
  assert.ok(checkArchReviewRecord(loopRecord({ drafts: [] })).ok, 'loop で0件は通る');
  const noBody = loopRecord({ drafts: [{ title: 'docs: body なし', created: null }] });
  assert.equal(checkArchReviewRecord(noBody).ok, false, 'loop で body の無い下書きは誤り');
  assert.ok(checkArchReviewRecord({ ...noBody, trigger: 'manual' }).ok, 'manual なら body は任意');
  const fourManual = { ...four, trigger: 'manual' as const };
  assert.ok(checkArchReviewRecord(fourManual).ok, 'manual なら4件以上でも通る');
});

// ---- renderArchReviewRecord（下書きの数と採用数） ----

test('renderArchReviewRecord：本文に「下書き N 件・採用 M 件」の行が出る（採用は created か commented が null でない下書き）', () => {
  const r = loopRecord({
    drafts: [
      { title: 'docs: a', body: DRAFT_BODY, created: null },
      { title: 'docs: b', body: DRAFT_BODY, created: 250 },
      { title: 'docs: c', body: DRAFT_BODY, created: null, duplicateOf: 123, commented: 123 },
    ],
  });
  const body = renderArchReviewRecord(r, SESSION);
  assert.ok(body.includes('下書き 3 件・採用 2 件'), body);
  const none = renderArchReviewRecord(loopRecord({ drafts: [] }), SESSION);
  assert.ok(none.includes('下書き 0 件・採用 0 件'), none);
  const unadopted = renderArchReviewRecord(loopRecord({ drafts: [{ title: 'docs: a', body: DRAFT_BODY, created: null, commented: null }] }), SESSION);
  assert.ok(unadopted.includes('下書き 1 件・採用 0 件'), unadopted);
});

test('renderArchReviewRecord：trigger・body・duplicateOf・commented を含む記録を parseArchReviewRecord で読み戻せる', () => {
  const value = loopRecord({
    drafts: [
      { title: 'docs: a', body: DRAFT_BODY, created: null, duplicateOf: 123, commented: 123 },
      { title: 'docs: b', body: DRAFT_BODY, created: null },
    ],
  });
  const r = parseArchReviewRecord(renderArchReviewRecord(value, SESSION));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.record, value);
});

test('renderArchReviewRecord：下書きの body は ```arch-review の JSON の中にだけあり、人が読む部分に重ねない', () => {
  const MARK = '下書きの本文だけにある目印の文字列ZQX';
  const value = loopRecord({ drafts: [{ title: 'docs: a', body: `### Goal\n\n${MARK}\n\n### Requirements\n\n- r\n\n### Acceptance Criteria\n\n- [ ] a`, created: null }] });
  const body = renderArchReviewRecord(value, SESSION);
  const fenceStart = body.indexOf('```arch-review');
  assert.ok(fenceStart >= 0, '```arch-review がありません');
  assert.equal(body.split(MARK).length - 1, 1, '下書きの body が2回以上出ています');
  assert.ok(body.indexOf(MARK) > fenceStart, '下書きの body がフェンスの外にあります');
  assert.ok(!body.slice(0, fenceStart).includes('### Goal'), '人が読む部分に下書きの見出しがあります');
});

// ---- archReviewBodyErrors ----

test('archReviewBodyErrors：ARCH_REVIEW_COMMENT_MAX までは空、超えれば誤り1件', () => {
  assert.deepEqual(archReviewBodyErrors(''), []);
  assert.deepEqual(archReviewBodyErrors('a'.repeat(ARCH_REVIEW_COMMENT_MAX)), []);
  const errors = archReviewBodyErrors('a'.repeat(ARCH_REVIEW_COMMENT_MAX + 1));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(typeof errors[0], 'string');
});

// ---- adoptArchReviewDraft ----

test('adoptArchReviewDraft：下書きの番号（1始まり）の created に Issue 番号を書き、ほかは変えない', () => {
  const original = loopRecord();
  const c = recordComment(original);
  const r = adoptArchReviewDraft(c, 1, 400, {}, config);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.record.drafts[0]!.created, 400);
  assert.deepEqual(r.record.drafts.slice(1), original.drafts.slice(1), 'ほかの下書きが変わっています');
  assert.equal(r.record.headSha, original.headSha);
  assert.equal(r.record.baseSha, original.baseSha);
  assert.deepEqual(r.record.prs, original.prs);
  assert.deepEqual(r.record.summary, original.summary);
  assert.equal(r.record.trigger, 'loop');
  const reparsed = parseArchReviewRecord(r.body);
  assert.ok(reparsed.ok, JSON.stringify(reparsed));
  assert.deepEqual(reparsed.record, r.record);
  assert.ok(r.body.includes('下書き 3 件・採用 2 件'), r.body);
});

test('adoptArchReviewDraft：本文は元のコメントの目印のセッションを残して renderArchReviewRecord で作り直したもの', () => {
  const c = recordComment(loopRecord(), {}, SESSION);
  const r = adoptArchReviewDraft(c, 1, 400, {}, config);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.body.startsWith(claudeMark(SESSION)), '元のセッションの目印が残っていません');
  assert.equal(r.body, renderArchReviewRecord(r.record, SESSION));
  const noSession = adoptArchReviewDraft(recordComment(loopRecord(), {}, null), 1, 400, {}, config);
  assert.ok(noSession.ok, JSON.stringify(noSession));
  assert.equal(noSession.body, renderArchReviewRecord(noSession.record, null));
});

test('adoptArchReviewDraft：--comment（opts.comment）なら commented に Issue 番号を書く（duplicateOf と同じ番号のときだけ）', () => {
  const c = recordComment(loopRecord());
  const r = adoptArchReviewDraft(c, 2, 123, { comment: true }, config);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.record.drafts[1]!.commented, 123);
  assert.equal(r.record.drafts[1]!.created, null, 'コメントの採用で created を書いています');
  assert.equal(adoptArchReviewDraft(c, 2, 124, { comment: true }, config).ok, false, 'duplicateOf と違う番号は誤り');
  assert.equal(adoptArchReviewDraft(c, 1, 123, { comment: true }, config).ok, false, 'duplicateOf の無い下書きは誤り');
});

test('adoptArchReviewDraft：下書きの番号が範囲外・既に採用済みなら誤り', () => {
  const c = recordComment(loopRecord({
    drafts: [
      { title: 'docs: a', body: DRAFT_BODY, created: null },
      { title: 'docs: b', body: DRAFT_BODY, created: null, duplicateOf: 123, commented: 123 },
      { title: 'docs: c', body: DRAFT_BODY, created: 250 },
    ],
  }));
  for (const index of [0, -1, 4, 1.5]) assert.equal(adoptArchReviewDraft(c, index, 400, {}, config).ok, false, `index=${index}`);
  assert.equal(adoptArchReviewDraft(c, 2, 400, {}, config).ok, false, 'commented 済み');
  assert.equal(adoptArchReviewDraft(c, 3, 400, {}, config).ok, false, 'created 済み');
  assert.equal(adoptArchReviewDraft(c, 2, 123, { comment: true }, config).ok, false, 'commented 済みにコメントで採用');
});

test('adoptArchReviewDraft：App の名義・コラボレーター以外・Claude の目印なし・記録が読めないコメントは誤り', () => {
  const body = renderArchReviewRecord(loopRecord(), SESSION);
  const cases: [string, IssueComment][] = [
    ['App', comment(body, { user: { login: APP, type: 'Bot' } } as Partial<IssueComment>)],
    ['CONTRIBUTOR', comment(body, { author_association: 'CONTRIBUTOR' })],
    ['NONE', comment(body, { author_association: 'NONE' })],
    ['目印なし', comment(body.replace(claudeMark(SESSION), ''))],
    ['記録が壊れている', comment(`${claudeMark(SESSION)}\n\n\`\`\`arch-review\n{ broken\n\`\`\``)],
    ['記録なし', comment(`${claudeMark(SESSION)}\nふつうのコメント`)],
  ];
  for (const [name, c] of cases) {
    const r = adoptArchReviewDraft(c, 1, 400, {}, config);
    assert.equal(r.ok, false, name);
    assert.ok(!r.ok && r.errors.length > 0, `${name}：errors が空`);
  }
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.ok(adoptArchReviewDraft(comment(body, { author_association: association }), 1, 400, {}, config).ok, association);
  }
});

test('adoptArchReviewDraft：作り直した本文が ARCH_REVIEW_COMMENT_MAX を超えるなら誤り', () => {
  const big = 'あ'.repeat(ARCH_REVIEW_COMMENT_MAX);
  const c = recordComment(loopRecord({ trigger: 'manual', drafts: [{ title: 'docs: 長い', body: `### Goal\n\n${big}`, created: null }] }));
  const r = adoptArchReviewDraft(c, 1, 400, {}, config);
  assert.equal(r.ok, false, '長さの上限を超えた本文を返しています');
});

// ---- archReviewAdoption ----

test('archReviewAdoption：正しい記録のコメントすべてから、記録の数・下書きの数・採用数・採用待ち（1始まりの番号）を数える', () => {
  const first = recordComment(loopRecord({ headSha: OLDER, baseSha: null, drafts: [
    { title: 'docs: 1-1', body: DRAFT_BODY, created: 210 },
    { title: 'docs: 1-2', body: 'b12', created: null },
  ] }));
  const second = recordComment(loopRecord({ drafts: [
    { title: 'docs: 2-1', body: 'b21', created: null, duplicateOf: 123 },
    { title: 'docs: 2-2', body: DRAFT_BODY, created: null, duplicateOf: 124, commented: 124 },
    { title: 'docs: 2-3', created: null, commented: null, body: 'b23' },
  ] }));
  const legacy = comment([claudeMark(), '記録', '', '```arch-review', JSON.stringify({
    version: 1, baseSha: null, headSha: PREV, prs: [1], summary: [], drafts: [{ title: 'docs: 古い', created: null }],
  }), '```'].join('\n'));
  const ignored = [
    comment(renderArchReviewRecord(loopRecord(), SESSION), { user: { login: APP, type: 'Bot' } } as Partial<IssueComment>),
    comment(renderArchReviewRecord(loopRecord(), SESSION), { author_association: 'NONE' }),
    comment(renderArchReviewRecord(loopRecord(), SESSION).replace(claudeMark(SESSION), '')),
    comment(`${claudeMark()}\n\`\`\`arch-review\n{ broken\n\`\`\``),
    comment('ふつうのコメント'),
  ];
  const a = archReviewAdoption([first, ...ignored, second, legacy], config);
  assert.equal(a.records, 3);
  assert.equal(a.drafts, 6);
  assert.equal(a.adopted, 2);
  const pending = a.pending.map((p) => ({ commentId: p.commentId, index: p.index, title: p.title, duplicateOf: p.duplicateOf }));
  assert.deepEqual(pending.sort((x, y) => x.commentId - y.commentId || x.index - y.index), [
    { commentId: first.id, index: 2, title: 'docs: 1-2', duplicateOf: undefined },
    { commentId: second.id, index: 1, title: 'docs: 2-1', duplicateOf: 123 },
    { commentId: second.id, index: 3, title: 'docs: 2-3', duplicateOf: undefined },
    { commentId: legacy.id, index: 1, title: 'docs: 古い', duplicateOf: undefined },
  ]);
  assert.equal(a.pending.find((p) => p.commentId === second.id && p.index === 1)?.body, 'b21');
});

test('archReviewAdoption：記録が無ければ0件と空の採用待ち', () => {
  assert.deepEqual(archReviewAdoption([], config), { records: 0, drafts: 0, adopted: 0, pending: [] });
});

test('archReviewAdoption：adoptArchReviewDraft の本文で書き換えると、採用数が増え採用待ちから消える', () => {
  const c = recordComment(loopRecord());
  const before = archReviewAdoption([c], config);
  const r = adoptArchReviewDraft(c, 1, 400, {}, config);
  assert.ok(r.ok, JSON.stringify(r));
  const after = archReviewAdoption([{ ...c, body: r.body }], config);
  assert.equal(after.drafts, before.drafts);
  assert.equal(after.adopted, before.adopted + 1);
  assert.ok(!after.pending.some((p) => p.index === 1), '採用した下書きが採用待ちに残っています');
});

// ---- latestArchReviewRecord（採用で編集した記録があっても作成の新しいものを選ぶ） ----

test('latestArchReviewRecord：採用で編集した古い記録（updated_at が新しい）より、created_at の新しい記録を前回に選ぶ', () => {
  const older = recordComment(loopRecord({ headSha: OLDER }), { created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-30T00:00:00Z' });
  const adopted = adoptArchReviewDraft(older, 1, 400, {}, config);
  assert.ok(adopted.ok, JSON.stringify(adopted));
  const edited = { ...older, body: adopted.body };
  const newer = recordComment(loopRecord({ headSha: TIP }), { created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z' });
  const r = latestArchReviewRecord([newer, edited], config);
  assert.equal(r?.record.headSha, TIP);
  assert.equal(r?.comment.id, newer.id);
});

// ---- checkIssueDrafts（max） ----

const issueDraft = (i: number) => ({ title: `refactor(harness): 下書き ${i}`, body: DRAFT_BODY });

test('checkIssueDrafts：max を渡すと件数が max を超えたら誤り、渡さなければ4件以上でも通る', () => {
  const four = [1, 2, 3, 4].map(issueDraft);
  const three = four.slice(0, 3);
  assert.equal(checkIssueDrafts(four, 3).ok, false);
  assert.ok(checkIssueDrafts(three, 3).ok);
  assert.ok(checkIssueDrafts([], 3).ok);
  assert.ok(checkIssueDrafts(four).ok, 'max なしは今と同じ');
  assert.ok(checkIssueDrafts([1, 2, 3, 4, 5, 6].map(issueDraft)).ok);
});

// ---- agent.ts のコマンド ----

test('使い方のコメントに arch-review-pending・arch-review-adopt が書かれている', () => {
  const documented = documentedAgentCommands();
  for (const name of ['arch-review-drafts', 'arch-review-pending', 'arch-review-adopt']) assert.ok(documented.has(name), `${name} が使い方のコメントにありません`);
});

test('arch-review の使い方のコメントに --loop・--comment が書かれている', () => {
  const src = read('harness/scripts/agent/commands/arch-review.ts');
  assert.match(src, /arch-review-drafts <file> \[--loop\]/);
  assert.match(src, /arch-review-adopt <[^>]+> <[^>]+> <[^>]+> \[--comment\]/);
});

const runDrafts = (value: unknown, extra: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-review-loop-'));
  const file = join(dir, 'drafts.json');
  writeFileSync(file, JSON.stringify(value));
  return spawnSync(process.execPath, ['harness/scripts/agent.ts', 'arch-review-drafts', file, ...extra], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  });
};

test('agent.ts arch-review-drafts --loop：4件の下書きは誤りで止まり、--loop なしなら通る', () => {
  const four = [1, 2, 3, 4].map(issueDraft);
  const loop = runDrafts(four, ['--loop']);
  assert.notEqual(loop.status, 0, `--loop で4件が通りました：${loop.stdout}`);
  assert.notEqual(loop.status, null, loop.stderr);
  const manual = runDrafts(four, []);
  assert.equal(manual.status, 0, manual.stderr);
});

test('agent.ts arch-review-drafts --loop：3件の下書きは通る', () => {
  const r = runDrafts([1, 2, 3].map(issueDraft), ['--loop']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('refactor(harness): 下書き 3'), r.stdout);
});

// ---- skill・docs ----

const SKILL = '.claude/skills/arch-review/SKILL.md';
const OPERATIONS = 'docs/operations.md';
const AGENT = '.claude/agents/arch-reviewer.md';
const LOOP_HEADING = '## /loop で回すとき';

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const sentences = (text: string): string[] => text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s !== '');

test('arch-review の description：1文目は今と同じで、「arch-review の下書きを選ぶ」がある', () => {
  const fm = frontmatter(read(SKILL));
  const description = fm.description ?? '';
  const first = description.slice(0, description.indexOf('。') + 1);
  assert.equal(first, '人が付き添うセッションで、Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれ（重複・置き場所・docs との食い違い・コードの書き方）を見つけて、直す Issue の下書きを人に示す。');
  assert.ok(description.includes('arch-review の下書きを選ぶ'), `description に「arch-review の下書きを選ぶ」がありません：${description}`);
});

test('arch-review の「## 入力」に --loop がある', () => {
  assert.ok(section(read(SKILL), '## 入力').includes('--loop'), '「## 入力」に --loop がありません');
});

test('arch-review に「## /loop で回すとき」の節があり、/loop の例はどれも --loop を付けている', () => {
  const loop = section(read(SKILL), LOOP_HEADING);
  assert.ok(loop !== '', `「${LOOP_HEADING}」がありません`);
  const examples = loop.split('\n').slice(1)
    .map((l) => l.match(/^\s*(?:[-*]\s+)?`?(\/loop\s[^`]*)`?/)?.[1])
    .filter((x): x is string => x !== undefined && x.includes('/arch-review'));
  assert.ok(examples.length > 0, '/loop の例（`/loop 6h /arch-review --loop` のような行）がありません');
  for (const ex of examples) assert.ok(/\/arch-review\b.*--loop\b/.test(ex), `--loop の無い /loop の例：${ex}`);
});

test('「## /loop で回すとき」に間隔・止め方・観測・採用のコマンド・前回の続きの解き方・docs へのリンクがある', () => {
  const loop = section(read(SKILL), LOOP_HEADING);
  for (const word of ['間隔', '止め', 'observe.ts', 'arch-review-pending', 'arch-review-adopt', 'truncated', '--since', '記録を残さ', 'operations.md#見直しを-loop-で回す']) {
    assert.ok(loop.includes(word), `「${LOOP_HEADING}」に「${word}」がありません`);
  }
});

test('「## /loop で回すとき」：AskUserQuestion を呼ばず、gh issue create をしないと書いている', () => {
  const s = sentences(section(read(SKILL), LOOP_HEADING));
  assert.ok(s.some((x) => x.includes('AskUserQuestion') && /ない|ません/.test(x)), 'AskUserQuestion を呼ばない文がありません');
  assert.ok(s.some((x) => x.includes('gh issue create') && /ない|ません/.test(x)), 'gh issue create をしない文がありません');
});

test('「## /loop で回すとき」：見る PR が無い（prs が空）なら記録を残さない', () => {
  const s = sentences(section(read(SKILL), LOOP_HEADING));
  assert.ok(s.some((x) => x.includes('記録を残さ') && /prs|PR/.test(x)), 'prs が空なら記録を残さない文がありません');
});

test('docs/operations.md に「## 見直しを /loop で回す」の見出しがある', () => {
  assert.ok(read(OPERATIONS).split('\n').includes('## 見直しを /loop で回す'), '見出しがありません');
});

test('arch-reviewer の定義に observe.ts の記述がある', () => {
  assert.ok(read(AGENT).includes('observe.ts'), `${AGENT} に observe.ts がありません`);
});
