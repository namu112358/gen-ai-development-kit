import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CLAUDE_MARK } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import {
  composePanel, parseChangedLines, parsePanelOutputs, parsePanelRecord, pastPrMaterial, previousFromJudgeInput, renderPanelRecord, subagentCost,
  PANEL_MODES, PANEL_OUTPUT_NAMES, type CheckResult, type PanelMode, type PanelRecord,
} from '../lib/review-panel.ts';
import { checkJudgeInput, judgedHeadOf, judgedPrOf, splitArgs } from '../lib/session-inputs.ts';
import type { PullRequest } from '../lib/state.ts';
import { findSessionTranscripts } from '../lib/usage.ts';
import { addWorktree, mainRepoRoot, removeWorktree } from '../lib/worktree.ts';

/**
 * 合体版のレビュー（.claude/skills/review-panel/SKILL.md）の CLI。判断は harness/lib/review-panel.ts の純粋関数で行い、ここは git・npm・API を呼ぶだけ。
 *
 *   node harness/scripts/review-panel.ts mode
 *       harness.config.json の reviewPanel.mode（off / shadow / enforce。無ければ off）を出力
 *   node harness/scripts/review-panel.ts check <judge-input>
 *       ⑧：judge-input の headSha を detached の worktree（リポジトリの外）に取り出し、npm ci の後 npm run check を動かして
 *       { headSha, exitCode, outputTail }（出力の末尾 60 行）を JSON のファイルに書き、パスを出力。worktree は必ず消す。
 *       npm ci が失敗したら⑧の指摘にせず止まる
 *   node harness/scripts/review-panel.ts findings <dir>
 *       <dir> の担当の出力（intake.json・lens1.json〜lens5.json・ac-scope.json・safety.json）を検査し、採点に渡す指摘の一覧（ID 付き）を出力
 *   node harness/scripts/review-panel.ts compose <pr> <dir> --judge-input <file> [--session <jsonl>]
 *       <dir> の担当の出力・score-<id>.json・check.json と、judge-input の前回の判定（あれば git diff -U0 <前回の head> <headSha> の変わった行）から組み立て、
 *       組み立ての出力（review-<PR>-<head7>.json。reviewer の出力と同じ形）と記録のコメント（panel-<PR>-<head7>.md）を書いてパスを出力。
 *       judge-input の PR 番号が <pr> と違う、今の PR の head や check.json の headSha が judge-input の headSha と違えば止まる。
 *       費用は --session（無ければこのセッション）のサブエージェントの記録から数える
 *   node harness/scripts/review-panel.ts post <pr> <記録のファイル>
 *       記録のコメントを検査し、PR 番号が合い、headSha が今の PR の head と同じときだけ投稿する
 *
 * リポジトリは GITHUB_REPOSITORY か git remote から決める。
 */

const config = loadConfig();
const TAIL_LINES = 60;

function fail(errors: string[]): never {
  console.error(['エラー:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(2);
}

function git(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(['remote', 'get-url', 'origin']).stdout.trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ?? url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin から owner/repo を判別できません: ${url}`);
  return m[1]!;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail([`${file}: JSON として読めません: ${(e as Error).message}`]);
  }
}

function writeTemp(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'review-panel-'));
  return Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
}

function panelMode(): PanelMode {
  const mode = config.reviewPanel?.mode ?? 'off';
  if (!(PANEL_MODES as readonly string[]).includes(mode)) fail([`harness.config.json の reviewPanel.mode（${String(mode)}）は ${PANEL_MODES.join(' / ')} のどれかにする`]);
  return mode;
}

function check(inputFile: string): string {
  const text = readFileSync(inputFile, 'utf8');
  const head = judgedHeadOf(text);
  const pr = judgedPrOf(text);
  if (!head || pr === null) fail([`${inputFile}: judge-input の先頭2行（headSha と PR）を読めません`]);
  const fetched = git(['fetch', '-q', 'origin']);
  if (fetched.status !== 0) console.error(`警告: git fetch origin が失敗しました。手元の ref で続けます: ${fetched.stderr.trim()}`);
  const opts = { root: mainRepoRoot(), defaultBranch: config.defaultBranch };
  const path = addWorktree(head, true, opts);
  try {
    const ci = spawnSync('npm', ['ci'], { cwd: path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ci.status !== 0) throw new Error(`npm ci が失敗しました（⑧の指摘にはしません。やり直すか人に返す）:\n${`${ci.stdout ?? ''}${ci.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n')}`);
    const r = spawnSync('npm', ['run', 'check'], { cwd: path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
    const result: CheckResult = { headSha: head, exitCode: r.status ?? 1, outputTail: output };
    return writeTemp({ [`check-${pr}-${head.slice(0, 7)}.json`]: `${JSON.stringify(result, null, 2)}\n` })[0]!;
  } finally {
    removeWorktree(head, opts);
  }
}

function readOutputs(dir: string) {
  const files: Record<string, unknown> = {};
  for (const name of PANEL_OUTPUT_NAMES) {
    const path = join(dir, `${name}.json`);
    if (!existsSync(path)) fail([`${path} がありません`]);
    files[name] = readJson(path);
  }
  const parsed = parsePanelOutputs(files);
  if (!parsed.ok) fail(parsed.errors);
  return parsed.value;
}

function findings(dir: string): string {
  const { intake, findings: list } = readOutputs(dir);
  return JSON.stringify({
    eligible: intake.eligible,
    claudeMd: intake.claudeMd,
    findings: list.map((f) => ({ ...f, falsePositiveExamples: f.source.startsWith('lens') })),
  }, null, 2);
}

/** サブエージェントの jsonl と、同じ名前の meta.json */
function subagentEntries(session?: string): { meta: { agentType?: string; description?: string }; lines: string[] }[] {
  const [, ...subagents] = findSessionTranscripts(process.cwd(), session);
  return subagents.flatMap((f) => {
    const metaPath = join(dirname(f), `${basename(f, '.jsonl')}.meta.json`);
    try {
      const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { agentType?: string; description?: string }) : {};
      return [{ meta, lines: readFileSync(f, 'utf8').split('\n') }];
    } catch {
      return [];
    }
  });
}

async function compose(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'compose <pr> <dir> --judge-input <file> [--session <jsonl>]';
  const a = splitArgs(args, ['--judge-input', '--session']);
  if (!a.ok) fail([...a.errors, usage]);
  const { positional, options } = a.value;
  const [prArg, dir] = positional;
  const inputFile = options['--judge-input'];
  if (positional.length !== 2 || !prArg || !dir || !inputFile || !/^\d+$/.test(prArg)) fail([usage]);
  const pr = Number(prArg);

  const mode = panelMode();
  if (mode === 'off') fail(['reviewPanel.mode が off です。合体版は動かしません']);
  const text = readFileSync(inputFile, 'utf8');
  const judged = checkJudgeInput(text, pr);
  if (!judged.ok) fail(judged.errors.map((e) => `${inputFile}: ${e}`));
  const head = judged.value;

  const outputs = readOutputs(dir);
  if (!outputs.intake.eligible) fail([`review-intake が対象外と答えています（${outputs.intake.reason}）。組み立てません`]);
  const scores = readdirSync(dir).filter((f) => /^score-.+\.json$/.test(f)).sort().map((f) => readJson(join(dir, f)));
  const checkRaw = readJson(join(dir, 'check.json')) as Partial<CheckResult>;
  if (checkRaw.headSha !== head) fail([`check.json の headSha（${String(checkRaw.headSha)}）が judge-input の head（${head}）と違います。⑧をやり直す`]);
  if (typeof checkRaw.exitCode !== 'number' || typeof checkRaw.outputTail !== 'string') fail(['check.json は { headSha, exitCode, outputTail } ではありません']);

  const previous = previousFromJudgeInput(text);
  if (!previous.ok) fail(previous.errors);
  let changedLines = null;
  if (previous.value) {
    const fetched = git(['fetch', '-q', 'origin']);
    if (fetched.status !== 0) console.error(`警告: git fetch origin が失敗しました。手元の ref で続けます: ${fetched.stderr.trim()}`);
    const diff = git(['diff', '-U0', previous.value.headSha, head]);
    if (diff.status !== 0) fail([`git diff -U0 ${previous.value.headSha} ${head} が失敗しました: ${diff.stderr.trim()}`]);
    changedLines = parseChangedLines(diff.stdout);
  }

  // 段階5の再確認（公式の段階7）：組み立てる直前に、判定する head が今の head のままか
  const current = await gh.get<PullRequest>(`/pulls/${pr}`);
  if (current.head.sha !== head) fail([`判定する head（${head}）と今の PR の head（${current.head.sha}）が違います。judge-input からやり直す`]);

  const composed = composePanel({ findings: outputs.findings, notes: outputs.notes, scores, check: checkRaw as CheckResult, previous: previous.value, changedLines });
  if (!composed.ok) fail(composed.errors);
  const head7 = head.slice(0, 7);
  const record: PanelRecord = {
    version: 1,
    pr,
    headSha: head,
    mode,
    review: composed.value.review,
    findings: composed.value.findings,
    check: { exitCode: checkRaw.exitCode },
    material: pastPrMaterial(text),
    cost: subagentCost(subagentEntries(options['--session']), pr, head7, config.pricing ?? {}),
  };
  const [reviewPath, recordPath] = writeTemp({
    [`review-${pr}-${head7}.json`]: `${JSON.stringify(composed.value.review, null, 2)}\n`,
    [`panel-${pr}-${head7}.md`]: renderPanelRecord(record),
  });
  return JSON.stringify({ review: reviewPath, record: recordPath }, null, 2);
}

async function post(gh: GitHub, pr: number, file: string): Promise<string> {
  const body = readFileSync(file, 'utf8');
  if (!body.includes(CLAUDE_MARK)) fail([`${file}: Claude の目印がありません`]);
  for (const fence of ['```agent-verdict', '```agent-plan', '```agent-claim']) if (body.includes(fence)) fail([`${file}: ${fence} を含む本文は投稿しません`]);
  const parsed = parsePanelRecord(body);
  if (!parsed.ok) fail(parsed.errors);
  if (parsed.value.pr !== pr) fail([`記録の pr（${parsed.value.pr}）が #${pr} と一致しません`]);
  const current = await gh.get<PullRequest>(`/pulls/${pr}`);
  if (current.head.sha !== parsed.value.headSha) fail([`記録の headSha が今の head（${current.head.sha}）と一致しません。判定し直す`]);
  const posted = await gh.comment(pr, body);
  return JSON.stringify({ posted: posted.html_url }, null, 2);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'mode': return void console.log(panelMode());
      case 'check': return void console.log(check(args[0] ?? fail(['check <judge-input>'])));
      case 'findings': return void console.log(findings(args[0] ?? fail(['findings <dir>'])));
      case 'compose': return void console.log(await compose(new GitHub(transportFromEnv(), repository()), args));
      case 'post': {
        if (!args[0] || !/^\d+$/.test(args[0]) || !args[1]) fail(['post <pr> <記録のファイル>']);
        return void console.log(await post(new GitHub(transportFromEnv(), repository()), Number(args[0]), args[1]));
      }
      default:
        console.error('usage: see header of harness/scripts/review-panel.ts');
        process.exit(1);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

await main();
