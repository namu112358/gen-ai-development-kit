import { type AgentCommand, harnessDrift } from '../cli.ts';

/**
 * このセッションの読み込み（始めたときのハーネスのファイルの版）を origin の既定ブランチと比べる（Issue #199。読むだけ）。
 *
 *   node harness/scripts/agent.ts harness-drift            このセッションの読み込みの記録（SessionStart の hook が git の共通ディレクトリの下の
 *                                                           agent-harness/loaded/<セッションの ID>.json に書く）を、git fetch した origin の既定ブランチと比べて JSON で出す
 *                                                           （judged・stale・changed・added・removed・base・mergeBase・recordedAt・note）。記録が無ければ {"judged": false}。
 *                                                           ブランチが自分で変えたファイルは、origin もその後に変えたときだけ古いとする（harness/lib/harness-drift.ts の compareHarness）。
 *                                                           違うファイルは、記録の HEAD から origin までで最初に触れた commit の時刻から猶予（harness.config.json の harnessDrift.graceHours、
 *                                                           既定 6 時間）を過ぎるまで古いとせず、pending に並べる（assessDrift。Issue #812）。規則・.claude/settings.json・判定の担当
 *                                                           （reviewer・risk-agent・review-* の agent、judge・review-panel の skill）は猶予を置かない（NO_GRACE_PATHS）。
 *                                                           .claude/skills/・.claude/agents/ の下の README.md は比べない。足す欄は pending・graceHours・pendingUntil。
 *                                                           古いときの交代の手順は ship・fleet の SKILL.md の「ハーネスが更新されたときの交代」
 */
export const commands: AgentCommand[] = [
  { name: 'harness-drift', run: () => void console.log(JSON.stringify(harnessDrift() ?? { judged: false }, null, 2)) },
];
