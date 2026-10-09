/**
 * テストファイルの削除の移し先を Jev に問う材料・要求・答えのまとめ・要約の節・記録の型（Epic #511、Issue #513）。GitHub も Jev も呼ばない。
 * PR 本文は「対応表があるか」の確かめにだけ使い、Jev の材料には入れない（セッションの文で Jev を誘導できないように）。
 * 材料は diff だけ：消したテストファイルの削除の行（中身全部）と、移し先（この PR で足した・変えたテストファイル）の追加の行。
 * 問いは消したファイルごとに Noul の1問。確率の最小値が jev.thresholds.testTamperProbability 以上のときだけ通す（モードと下限は test-tamper-jev.ts と同じ）。
 * 答えの欠け・下限の未設定は通さない。ゲートへの組み込みは #514。
 */
import type { HarnessConfig } from './config.ts';
import type { JevAnswers } from './jev.ts';
import { isTestFile } from './test-tamper.ts';
import { tamperAllows, tamperJevThreshold, type TamperJevMode } from './test-tamper-jev.ts';

/** App の記録の kind */
export const TEST_MOVE_JEV_KIND = 'test-move-jev';

/** 問いの版。問いの文や criteria を変えたら上げる（版が違う記録は使い回さない） */
export const TEST_MOVE_JEV_QUESTION_SET = 1;

/** 1回に問う消したファイルの上限（超えたら問わない） */
export const MAX_TEST_MOVE_FILES = 20;

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** 消したファイルの名前（最初の '.' より前の basename。harness/test/fleet-orca.test.ts → fleet-orca） */
const stem = (file: string): string => (file.split('/').pop() ?? file).split('.')[0] ?? file;

/** PR 本文に対応表（Markdown の表）があり、消した各ファイルの名前が本文に出てくるか。中身の正しさは見ない */
export function hasMoveTable(body: string | null, deletedFiles: string[]): { ok: true } | { ok: false; reason: string } {
  if (body === null || body.trim() === '') return { ok: false, reason: '対応表がありません' };
  const lines = body.split('\n');
  const hasTable = lines.some((l, i) => {
    const t = l.trim();
    return t.startsWith('|') && t.endsWith('|') && SEPARATOR.test(lines[i + 1] ?? '');
  });
  if (!hasTable) return { ok: false, reason: '対応表がありません' };
  for (const f of deletedFiles) {
    if (!body.includes(stem(f))) return { ok: false, reason: `表に ${f} がありません` };
  }
  return { ok: true };
}

interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  removed: string[];
  added: string[];
}

const pathOf = (raw: string, prefix: 'a/' | 'b/'): string | null => {
  const p = raw.replace(/\t.*$/, '').trim();
  if (p === '/dev/null') return null;
  return p.startsWith(prefix) ? p.slice(2) : p;
};

/** unified diff をファイルごとの削除の行・追加の行に分ける（材料の切り出しだけに使う） */
function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const lines = chunk.split('\n');
    const header = lines[0]!.match(/^diff --git a\/(.+?) b\/(.+)$/);
    let oldPath: string | null = header?.[1] ?? null;
    let newPath: string | null = header?.[2] ?? null;
    const removed: string[] = [];
    const added: string[] = [];
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        if (line.startsWith('--- ')) oldPath = pathOf(line.slice(4), 'a/');
        else if (line.startsWith('+++ ')) newPath = pathOf(line.slice(4), 'b/');
        continue;
      }
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
    }
    files.push({ oldPath, newPath, removed, added });
  }
  return files;
}

export interface TestMoveMaterial {
  /** 消したテストファイルと、その削除の行（中身全部） */
  deleted: { file: string; content: string }[];
  /** 移し先（この PR で足した・変えたテストファイル）と、その追加の行 */
  destinations: { file: string; added: string }[];
}

/** diff から材料を切り出す。deletedFiles は agent/tests が見つけた消したテストファイル */
export function testMoveMaterial(diff: string, patterns: string[], deletedFiles: string[]): TestMoveMaterial {
  const files = parseDiffFiles(diff);
  const deleted = deletedFiles.flatMap((file) => {
    const d = files.find((f) => f.oldPath === file && f.newPath === null);
    return d ? [{ file, content: d.removed.join('\n') }] : [];
  });
  const destinations = files.flatMap((f) => {
    if (f.newPath === null || !isTestFile(patterns, f.newPath) || f.added.length === 0) return [];
    return [{ file: f.newPath, added: f.added.join('\n') }];
  });
  return { deleted, destinations };
}

/** 問い（消したファイルごとに Noul の1問。yes が「移し先で確かめられている」） */
const question = (i: number) => ({
  type: 'noul',
  instructions:
    `deleted_files[${i}].content is the content of a test file that this change deleted. destinations is the code of the tests this change added or changed. ` +
    `Is every check of deleted_files[${i}] (the assertions, the expected values, the expected words, and the messages) checked somewhere in destinations, with the same or stricter conditions? ` +
    'Answer yes only if you can find where each check went. If you cannot find it, answer no.',
  criteria: {
    true: 'Each check in the deleted file appears in destinations with the same expected value, or a stricter one (for example, a table row that checks the same pattern), and the number of checks does not decrease.',
    false:
      'Any of these: the number of checks decreases; a condition is loosened (for example, the same line is replaced by a check anywhere in a section); the destination of a check cannot be found; or it is impossible to tell.',
  },
});

export type TestMoveRequestResult =
  | {
      ask: true;
      request: {
        model: string;
        state: { deleted_files: { file: string; content: string }[]; destinations: { file: string; added: string }[] };
        questions: Record<string, unknown>;
      };
    }
  | { ask: false; reason: string };

/** askJev に渡す要求。state は材料だけ（PR 本文は入れない）。問えない大きさのときは理由を返す */
export function testMoveRequest(config: HarnessConfig, material: TestMoveMaterial): TestMoveRequestResult {
  if (material.deleted.length === 0) return { ask: false, reason: '消したテストファイルがありません' };
  if (material.deleted.length > MAX_TEST_MOVE_FILES) return { ask: false, reason: `消したファイルが多すぎます（${material.deleted.length} 件 > ${MAX_TEST_MOVE_FILES}）` };
  if (material.destinations.length === 0) return { ask: false, reason: '移し先がありません' };
  const state = {
    deleted_files: material.deleted.map((d) => ({ file: d.file, content: d.content })),
    destinations: material.destinations.map((d) => ({ file: d.file, added: d.added })),
  };
  const size = JSON.stringify(state).length;
  if (size > config.jev.maxDiffChars) return { ask: false, reason: `材料が大きすぎます（${size} 文字 > ${config.jev.maxDiffChars}）` };
  const questions: Record<string, unknown> = {};
  material.deleted.forEach((_, i) => {
    questions[`deleted_${i}`] = question(i);
  });
  return { ask: true, request: { model: config.jev.model, state, questions } };
}

/** 消したファイルごとの結果（記録と要約に出す） */
export interface TestMoveLine {
  file: string;
  /** 移し先で確かめられている（yes）の確率。答えが欠けたら null */
  probability: number | null;
}

export interface TestMoveSummary {
  files: TestMoveLine[];
  /** 確率の最小値（欠けがあれば null） */
  probability: number | null;
  /** jev.thresholds.testTamperProbability（無ければ null） */
  threshold: number | null;
  allows: boolean;
}

/** 答えからファイルごとの確率・最小値・通すか。答えが欠けたら通さない */
export function summarizeTestMove(config: HarnessConfig, answers: JevAnswers, files: string[]): TestMoveSummary {
  return resummarizeTestMove(
    config,
    files.map((file, i) => {
      const p = answers?.[`deleted_${i}`]?.noul;
      return { file, probability: typeof p === 'number' && Number.isFinite(p) ? p : null };
    }),
  );
}

/** ファイルごとの確率から、最小値と今の下限で通すかを決め直す（記録の使い回しにも使う） */
export function resummarizeTestMove(config: HarnessConfig, files: TestMoveLine[]): TestMoveSummary {
  const probability = files.length === 0 || files.some((f) => f.probability === null) ? null : Math.min(...files.map((f) => f.probability!));
  return { files, probability, threshold: tamperJevThreshold(config), allows: tamperAllows(config, probability) };
}

/**
 * 判定の結果（ゲートが使う。#514）。applies が偽ならこの仕組みをかけない PR（要約にも出さない）。
 * asked が偽なら問わなかった・問えなかった（reason を要約に出す）。
 */
export type TestMoveOutcome =
  | { applies: false }
  | { applies: true; mode: TamperJevMode; asked: false; reason: string }
  | ({ applies: true; mode: TamperJevMode; asked: true; /** 同じ差分の記録を使った */ reused: boolean; model: string } & TestMoveSummary);

/** App の記録（kind=test-move-jev） */
export interface TestMoveRecord extends TestMoveSummary {
  version: 1;
  patchId: string;
  headSha: string;
  mode: TamperJevMode;
  model: string;
  questionSet: number;
}

const pct = (p: number | null) => (p !== null && Number.isFinite(p) ? `${Math.round(p * 100)}%` : '-');

/** agent/tests の要約に足す節。かけないときは空文字 */
export function renderTestMove(outcome: TestMoveOutcome | undefined): string {
  if (!outcome || !outcome.applies) return '';
  const lines = ['### テストファイルの削除の移し先（Jev）', ''];
  if (!outcome.asked) {
    lines.push(`Jev には問いませんでした：${outcome.reason}`, '', '移し先で確かめられないので止めています（人が確かめて `test:exempt` を付けるか、直してください）。');
    return lines.join('\n');
  }
  lines.push(
    '消したテストファイルの確かめが、この PR で足したテストに残っているか（移し先で同じかより厳しく確かめられているか）を Jev に問いました。',
    '',
    '| 消したファイル | 残っている確率 |',
    '| --- | --- |',
    ...outcome.files.map((f) => `| \`${f.file}\` | ${pct(f.probability)} |`),
    '',
    `- 最小値：${pct(outcome.probability)}`,
    `- 下限：${outcome.threshold === null ? '未設定（通しません）' : pct(outcome.threshold)}`,
    `- 通すか：${outcome.allows ? '通す' : '通さない（残っていない・答えが無いファイルがあります）'}`,
    `- モデル：${outcome.model}${outcome.reused ? '（同じ差分の記録を使いました）' : ''}`,
  );
  return lines.join('\n');
}
