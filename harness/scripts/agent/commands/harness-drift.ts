import { type AgentCommand, harnessDrift } from '../cli.ts';

/**
 * このセッションの読み込み（始めたときのハーネスのファイルの版）を origin の既定ブランチと比べる（Issue #199。読むだけ）。
 *
 *   node harness/scripts/agent.ts harness-drift            このセッションの読み込みの記録（SessionStart の hook が git の共通ディレクトリの下の
 *                                                           agent-harness/loaded/<セッションの ID>.json に書く）を、git fetch した origin の既定ブランチと比べて JSON で出す
 *                                                           （judged・stale・changed・added・removed・base・mergeBase・recordedAt・note）。記録が無ければ {"judged": false}。
 *                                                           ブランチが自分で変えたファイルは、origin もその後に変えたときだけ古いとする（harness/lib/harness-drift.ts の compareHarness）。
 *                                                           古いときの交代の手順は ship・fleet の SKILL.md の「ハーネスが更新されたときの交代」
 */
export const commands: AgentCommand[] = [
  { name: 'harness-drift', run: () => void console.log(JSON.stringify(harnessDrift() ?? { judged: false }, null, 2)) },
];
