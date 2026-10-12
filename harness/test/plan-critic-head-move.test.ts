// Issue #784：批評の間に HEAD が動いたとき、早送りで origin/<既定ブランチ> に追いついただけなら人に聞かずに批評を使い、それ以外は人に返すか。
// classifyHeadMove の境目（same・isAncestor が答えられない unknown・detach 同士）を偽の isAncestor で、
// `agent.ts head-check save/compare` の4つの場面（早送り・ブランチが変わった・祖先でない・origin に無い commit）を git の砂場で1回ずつ確かめる。
// 守りの判断なので、早送りと same 以外は use が偽（人に返す）・note が null・終了コード 1 であることも確かめる。控えの誤りは終了コード 2 で JSON を出さない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyHeadMove, type HeadMoveVerdict, type HeadSnapshot } from '../lib/head-move.ts';
import { sandbox } from './support/git-sandbox.ts';

type Sb = ReturnType<typeof sandbox>;

const kitRoot = join(import.meta.dirname, '..', '..');
const agentPath = join(kitRoot, 'harness', 'scripts', 'agent.ts');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('classifyHeadMove の境目：同じなら same、isAncestor が答えられなければ unknown、detach（空のブランチ）同士は同じブランチとみなす', () => {
  const ORIGIN = 'origin/main';
  /** 呼ばれた組を答える偽の isAncestor。表に無い組は false */
  const fake = (answers: Record<string, boolean | null>) => (ancestor: string, descendant: string) => {
    const k = `${ancestor}..${descendant}`;
    return k in answers ? answers[k]! : false;
  };
  const cases: {
    name: string;
    before: HeadSnapshot;
    after: HeadSnapshot;
    answers: Record<string, boolean | null>;
    verdict: HeadMoveVerdict;
    use: boolean;
  }[] = [
    { name: 'HEAD もブランチも同じ', before: { head: A, branch: 'main' }, after: { head: A, branch: 'main' }, answers: {}, verdict: 'same', use: true },
    {
      name: '前→後の祖先の確かめが答えられない',
      before: { head: A, branch: 'main' },
      after: { head: B, branch: 'main' },
      answers: { [`${A}..${B}`]: null },
      verdict: 'unknown',
      use: false,
    },
    {
      name: '後が origin に含まれるかの確かめが答えられない',
      before: { head: A, branch: 'main' },
      after: { head: B, branch: 'main' },
      answers: { [`${A}..${B}`]: true, [`${B}..${ORIGIN}`]: null },
      verdict: 'unknown',
      use: false,
    },
    {
      name: 'detach 同士で早送りだけ',
      before: { head: A, branch: '' },
      after: { head: B, branch: '' },
      answers: { [`${A}..${B}`]: true, [`${B}..${ORIGIN}`]: true },
      verdict: 'fast-forward',
      use: true,
    },
    {
      name: 'detach からブランチへ（HEAD は早送りでも）',
      before: { head: A, branch: '' },
      after: { head: B, branch: 'main' },
      answers: { [`${A}..${B}`]: true, [`${B}..${ORIGIN}`]: true },
      verdict: 'branch-changed',
      use: false,
    },
  ];
  for (const c of cases) {
    const r = classifyHeadMove(c.before, c.after, ORIGIN, fake(c.answers));
    assert.equal(r.verdict, c.verdict, c.name);
    assert.equal(r.use, c.use, c.name);
    if (c.verdict === 'fast-forward') assert.equal(r.note, `HEAD が早送りされた（${A.slice(0, 7)}→${B.slice(0, 7)}）`, c.name);
    else assert.equal(r.note, null, c.name);
  }
});

/** agent.ts head-check を砂場の本体（--repo）に向けて動かす。設定は kit の harness.config.json（defaultBranch は main、砂場の既定ブランチと同じ） */
function headCheck(sb: Sb, sub: 'save' | 'compare', file: string) {
  return spawnSync(process.execPath, [agentPath, 'head-check', sub, file, '--repo', sb.root], { cwd: kitRoot, encoding: 'utf8' });
}

/** 砂場を作って片付けを登録し、控えのファイルのパスを返す */
function setup(t: { after: (fn: () => void) => void }) {
  const sb = sandbox();
  t.after(sb.cleanup);
  return { sb, file: join(sb.dir, 'head-before.json') };
}

/** 今の HEAD を控える（終了コード 0 と、控えの中身が本体の HEAD とブランチであることを確かめる） */
function save(sb: Sb, file: string) {
  const r = headCheck(sb, 'save', file);
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as HeadSnapshot;
  assert.equal(saved.head, sb.git(sb.root, 'rev-parse', 'HEAD'));
  assert.equal(saved.branch, sb.git(sb.root, 'branch', '--show-current'));
  return saved;
}

function compare(sb: Sb, file: string) {
  const r = headCheck(sb, 'compare', file);
  const out = JSON.parse(r.stdout) as { verdict: HeadMoveVerdict; use: boolean; before: HeadSnapshot; after: HeadSnapshot; originRef: string; note: string | null };
  return { status: r.status, out, stderr: r.stderr };
}

/** origin を seed から1つ進める（本体は fetch もしない） */
function advanceOrigin(sb: Sb, file: string): string {
  const sha = sb.commit(sb.seed, file);
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  return sha;
}

test('head-check：本体が origin より古いまま控え、git pull --ff-only で追いついただけ → fast-forward で批評を使う（終了コード 0、note を1行）', (t) => {
  const { sb, file } = setup(t);
  const latest = advanceOrigin(sb, 'b.txt');
  const before = save(sb, file);
  assert.notEqual(before.head, latest, '控えた時点の本体は origin より古い');
  sb.git(sb.root, 'pull', '-q', '--ff-only');

  const { status, out, stderr } = compare(sb, file);
  assert.equal(status, 0, stderr);
  assert.equal(out.verdict, 'fast-forward');
  assert.equal(out.use, true);
  assert.equal(out.originRef, 'origin/main');
  assert.equal(out.before.head, before.head);
  assert.equal(out.after.head, latest);
  assert.equal(out.note, `HEAD が早送りされた（${before.head.slice(0, 7)}→${latest.slice(0, 7)}）`);
});

test('head-check：早送り以外（ブランチが変わった・祖先でない・origin に無い commit）は use が偽で人に返す（終了コード 1、note なし）', async (t) => {
  const cases: { name: string; verdict: HeadMoveVerdict; beforeSave?: (sb: Sb) => void; afterSave: (sb: Sb) => void }[] = [
    // HEAD は同じ commit でも、ブランチの名前が違えば早送りとはみなさない
    { name: 'switch -c で別のブランチ', verdict: 'branch-changed', afterSave: (sb) => void sb.git(sb.root, 'switch', '-q', '-c', 'other') },
    // 後の HEAD が前の HEAD を含まない（巻き戻し）。後の HEAD 自体は origin に含まれていても使わない
    {
      name: 'commit を足して控え、reset --hard HEAD~1 で戻す',
      verdict: 'not-ancestor',
      beforeSave: (sb) => void sb.commit(sb.root, 'local.txt'),
      afterSave: (sb) => void sb.git(sb.root, 'reset', '-q', '--hard', 'HEAD~1'),
    },
    // 前の HEAD の子孫だが、origin に無い commit を含む
    { name: '本体で commit を足す（origin に無い）', verdict: 'not-in-origin', afterSave: (sb) => void sb.commit(sb.root, 'local.txt') },
  ];
  for (const c of cases) {
    await t.test(c.name, (tt) => {
      const { sb, file } = setup(tt);
      c.beforeSave?.(sb);
      save(sb, file);
      c.afterSave(sb);

      const { status, out, stderr } = compare(sb, file);
      assert.equal(status, 1, stderr);
      assert.equal(out.verdict, c.verdict);
      assert.equal(out.use, false);
      assert.equal(out.note, null);
    });
  }
});

test('head-check compare：控えのファイルが無い・壊れている・head が無いときは終了コード 2 で、JSON を出さない（批評を使う判断にしない）', async (t) => {
  const cases: { name: string; content: string | null }[] = [
    { name: 'ファイルが無い', content: null },
    { name: 'JSON でない', content: 'not json' },
    { name: 'head が無い', content: JSON.stringify({ branch: 'main' }) },
  ];
  for (const c of cases) {
    await t.test(c.name, (tt) => {
      const { sb, file } = setup(tt);
      if (c.content !== null) writeFileSync(file, c.content);
      const r = headCheck(sb, 'compare', file);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(!r.stdout.trim().startsWith('{'), `JSON を出さない：${r.stdout}`);
    });
  }
});
