// Issue #557：critic-input の読み取り用 worktree（criticRepo の snapshot）を、並行するセッションの片付けで壊さない。
// 2つのセッションが同じ origin/main の版で criticRepo を呼ぶと、セッションごとに別の detach の worktree を作り、
// 片方が removeRef で片付けても、もう片方の読み先が残るか。同じセッション・違う Issue でも分かれるか。
// 同じセッション・同じ Issue なら同じパスを使い直すか。セッションを渡さないと今までどおり SHA の名前のパスになるか。
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { criticRepo, removeWorktree, worktreePath } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

type Sb = ReturnType<typeof sandbox>;

const real = (p: string) => realpathSync.native(p);
const same = (a: string, b: string) => assert.equal(real(a), real(b));

/** 砂場と、worktree の置き場所を砂場の下にした opts */
function setup(t: { after: (fn: () => void) => void }) {
  const sb = sandbox();
  t.after(sb.cleanup);
  const opts = { ...sb.opts, worktreeRoot: join(sb.dir, 'wt') };
  return { sb, opts };
}

/** origin を seed から1つ進める（本体は fetch もしない）。進めた後の origin/main の SHA を返す */
function advanceOrigin(sb: Sb, file: string): string {
  const sha = sb.commit(sb.seed, file);
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  return sha;
}

// どのテストも、origin を進めた後に本体（cwd）を古いままにし、Issue のブランチの worktree を作らない（snapshot の分岐を通す）

test('2つのセッションが同じ版で呼ぶと別のパス。片方を片付けても、もう片方の読み先が残る', (t) => {
  const { sb, opts } = setup(t);
  const base = advanceOrigin(sb, 'b.txt');
  assert.notEqual(sb.git(sb.root, 'rev-parse', 'HEAD'), base, '本体は古いまま');

  const a = criticRepo(557, sb.root, opts, 'A');
  const b = criticRepo(557, sb.root, opts, 'B');
  for (const r of [a, b]) {
    assert.equal(r.source, 'snapshot');
    assert.equal(r.base, base);
    assert.equal(sb.git(r.path, 'rev-parse', 'HEAD'), base, 'detach の worktree の HEAD は base');
  }
  assert.notEqual(real(a.path), real(b.path), 'セッションごとに別のパス');

  assert.ok(a.removeRef, 'snapshot には removeRef がある');
  removeWorktree(a.removeRef, opts);
  assert.equal(existsSync(a.path), false, '片付けたほうは消える');
  assert.equal(existsSync(b.path), true, 'もう片方の読み先は残る');
  assert.equal(sb.git(b.path, 'rev-parse', 'HEAD'), base);
});

test('同じセッションでも、違う Issue なら別のパス。片方を片付けても、もう片方が残る', (t) => {
  const { sb, opts } = setup(t);
  const base = advanceOrigin(sb, 'b.txt');

  const x = criticRepo(557, sb.root, opts, 'A');
  const y = criticRepo(548, sb.root, opts, 'A');
  assert.equal(x.source, 'snapshot');
  assert.equal(y.source, 'snapshot');
  assert.notEqual(real(x.path), real(y.path), 'Issue ごとに別のパス');

  removeWorktree(x.removeRef!, opts);
  assert.equal(existsSync(y.path), true);
  assert.equal(sb.git(y.path, 'rev-parse', 'HEAD'), base);
});

test('同じセッション・同じ Issue で2回呼ぶと同じパス。removeRef は critic-557- で始まり base を含む', (t) => {
  const { sb, opts } = setup(t);
  const base = advanceOrigin(sb, 'b.txt');

  const first = criticRepo(557, sb.root, opts, 'A');
  const again = criticRepo(557, sb.root, opts, 'A');
  assert.equal(first.source, 'snapshot');
  assert.equal(again.source, 'snapshot');
  same(again.path, first.path);
  assert.equal(again.removeRef, first.removeRef);

  const ref = first.removeRef ?? '';
  assert.ok(ref.startsWith('critic-557-'), ref);
  assert.ok(ref.includes(base), ref);
  assert.notEqual(ref, `critic-557-A-${base}`, 'セッション ID をそのまま名前に使わない（ハッシュにする）');
  same(first.path, worktreePath(sb.root, ref, opts.worktreeRoot));
});

test('セッションを渡さない・空文字 → 今までどおり SHA の名前のパス（removeRef は base）', async (t) => {
  const cases: { name: string; session?: string }[] = [{ name: 'session を渡さない' }, { name: 'session が空文字', session: '' }];
  for (const c of cases) {
    await t.test(c.name, (tt) => {
      const { sb, opts } = setup(tt);
      const base = advanceOrigin(sb, 'b.txt');

      const r = criticRepo(557, sb.root, opts, c.session);
      assert.equal(r.source, 'snapshot');
      assert.equal(r.removeRef, base);
      same(r.path, worktreePath(sb.root, base, opts.worktreeRoot));
      assert.equal(sb.git(r.path, 'rev-parse', 'HEAD'), base);
    });
  }
});
