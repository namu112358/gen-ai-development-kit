import { spawnSync } from 'node:child_process';
import { PROJECT_COMMAND_DEFAULTS, projectCommands } from '../../../lib/config.ts';
import { changedSummaryLine, changedTestPlan, readSources } from '../../../lib/related-tests.ts';
import { type AgentCommand, config } from '../cli.ts';

/**
 * 変更したファイルに関係するテストだけを流す（implement・fix の手順5。全体のテストは CI が流す。GitHub は呼ばない）。
 *
 *   node harness/scripts/agent.ts check-changed [--base <ref>] [--dry-run]
 *                                                           origin の既定ブランチ（--base で変えられる）との merge-base からの変更ファイル
 *                                                           （commit 済み・未 commit・未追跡）から、関係するテストを相対 import で選ぶ（harness/lib/related-tests.ts）。
 *                                                           1行目に「流すテスト：N 件（変更 M ファイル）」か「流すテスト：全体（理由）」を出し、--dry-run ならそこで終える。
 *                                                           そうでなければ npx tsc --noEmit を流し（落ちたらそこで終える）、続けて選んだテストを node --test で
 *                                                           （全体なら npm test で）流して、その終了コードで終わる。
 *
 * 関係するテストが分からない変更（土台のファイル・読めないファイル・関係するテストが無いファイル）は全体を流す。
 * project.checkCommand が null なら流さずに終える。既定（npm run check）でないときは、絞らずにそのコマンドを流す。
 */

/** 子プロセスを端末に繋いで流し、終了コードを返す（Windows でも npx・npm が動くよう shell を通す） */
function run(command: string, args: string[]): number {
  return spawnSync(command, args, { stdio: 'inherit', shell: true }).status ?? 1;
}

/** 行ごとの出力を取り出す（失敗したら null） */
function lines(args: string[]): string[] | null {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

function checkChanged(args: string[]): void {
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
  if (baseAt >= 0 && (base === undefined || base.startsWith('-'))) {
    console.error('使い方: node harness/scripts/agent.ts check-changed [--base <ref>] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const dryRun = args.includes('--dry-run');

  const { checkCommand } = projectCommands(config);
  if (checkCommand === null) {
    console.log('検証コマンドは設定されていません（project.checkCommand が null）');
    return;
  }
  if (checkCommand !== PROJECT_COMMAND_DEFAULTS.checkCommand) {
    console.log(`checkCommand が既定でないので全体を流した（${checkCommand}）`);
    if (!dryRun) process.exitCode = run(checkCommand, []);
    return;
  }

  // git diff --name-only のルートからの相対パスと、git ls-files・readFileSync・node --test の作業ディレクトリをそろえる
  const top = lines(['rev-parse', '--show-toplevel']);
  if (top?.[0] !== undefined) process.chdir(top[0]);

  const mergeBase = lines(['merge-base', base ?? `origin/${config.defaultBranch}`, 'HEAD'])?.[0];
  let plan;
  if (mergeBase === undefined) {
    plan = { mode: 'all' as const, reason: 'merge-base が取れない', changed: [] };
  } else {
    const changed = new Set<string>();
    for (const a of [
      ['diff', '--name-only', '--diff-filter=ACMRD', mergeBase],
      ['diff', '--name-only', 'HEAD'],
      ['ls-files', '--others', '--exclude-standard'],
    ]) for (const f of lines(a) ?? []) changed.add(f);
    const { sources, tests } = readSources();
    plan = changedTestPlan([...changed].sort(), sources, tests);
  }
  console.log(changedSummaryLine(plan));
  if (dryRun) return;

  const tsc = run('npx', ['tsc', '--noEmit']);
  if (tsc !== 0) {
    process.exitCode = tsc;
    return;
  }
  process.exitCode = plan.mode === 'subset' ? run('node', ['--test', ...plan.tests]) : run('npm', ['test']);
}

export const commands: AgentCommand[] = [{ name: 'check-changed', run: (args) => checkChanged(args) }];
