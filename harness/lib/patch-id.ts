import { spawnSync } from 'node:child_process';

/**
 * diff テキストの `git patch-id --verbatim` を返す。空の diff は 'empty'。
 * `--stable` は空白をすべて無視するため使わない（`rm -rf /tmp/x` と `rm -rf / tmp/x` が同じ値になる）。
 * `--verbatim`（Git 2.40+）は行番号と index 行だけを無視し、空白を含む変更内容を区別する。
 * git リポジトリの外でも動く（標準入力の diff だけを読む）。
 */
export function patchId(diff: string): string {
  if (diff.trim() === '') return 'empty';
  const result = spawnSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git patch-id failed: ${result.stderr}`);
  // 1つの diff に対して "<patch-id> <commit-id>" が1行出る。複数行なら連結して1つの値にする
  const ids = result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
  if (ids.length === 0) return 'empty';
  return ids.join('+');
}
