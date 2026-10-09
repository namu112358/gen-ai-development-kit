import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

/**
 * diff から、PR が足した・消した行とファイルの見出しだけを取り出した sha256（hex）。残りが無ければ 'empty'。
 * 文脈の行（先頭が空白）・`@@` の行・`index ` の行・空行を除くので、行番号・文脈・blob の sha の違いを無視する。
 * main の取り込みの判定の引き継ぎ（harness/gates/main-merge-carry.ts）だけに使い、App の push と merge commit の親の確かめと組にする
 * （単独では、同じ行を別の場所に動かした push を見分けられない）。
 */
export function changedLinesId(diff: string): string {
  const kept = diff.split('\n').filter((l) => l !== '' && !l.startsWith(' ') && !l.startsWith('@@') && !l.startsWith('index '));
  if (kept.length === 0) return 'empty';
  return createHash('sha256').update(kept.join('\n')).digest('hex');
}

/** PR 自身の差分（`<base>...<head>` の3点比較）。手元の git の設定（color・外部 diff・textconv・noprefix）の影響を受けない形で取る */
function prDiffLocal(base: string, head: string, cwd?: string): string {
  const result = spawnSync('git', [
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${head}`,
  ], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * 判定した head と今の head で、PR 自身の差分（`<base>...<head>`）の patch-id が同じかを返す。
 * App の受け付け（on-comment.ts の onVerdict：compare API の base...head の patch-id）と同じ比べ方。
 * git が失敗したら false（止める側）。
 */
export function samePrPatch(base: string, judgedHead: string, currentHead: string, cwd?: string): boolean {
  try {
    return patchId(prDiffLocal(base, judgedHead, cwd)) === patchId(prDiffLocal(base, currentHead, cwd));
  } catch {
    return false;
  }
}

/**
 * 判定した head のまま組み立て・投稿してよいかを判断する。よければ null、止めるならエラーの文言。
 * head が同じなら samePatch を呼ばない。違っても samePatch() が true（PR 自身の差分の patch-id が同じ）なら null。
 */
export function judgedHeadError(judgedHead: string, currentHead: string, samePatch: () => boolean): string | null {
  if (judgedHead === currentHead) return null;
  if (samePatch()) return null;
  return `判定した head（${judgedHead}）と今の head（${currentHead}）で PR 自身の差分（patch-id）が違う。判定し直す（judge-input からやり直す）`;
}
