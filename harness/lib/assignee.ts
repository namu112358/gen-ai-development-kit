/**
 * 担当（Issue の Assignee）の確かめ（Issue #172）。harness.config.json の requireAssignee が true のとき、Assignee がちょうど1人で今の GitHub のユーザーである Issue
 * （と、その Issue を Close する PR）にだけ着手する。アサインは人か、人に頼まれた付き添いのセッションが決め、エージェントは自分の判断ではアサインしない（ここはアサインを変えない）。
 * 判定は純粋関数で、GitHub の読み出しは AssigneeIo に任せる。
 */

/** Assignee が自分1人でない理由：誰もいない・他人1人・2人以上（自分を含む場合も） */
export type AssigneeProblem = 'none' | 'other' | 'multiple';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** ちょうど1人で自分なら null。login は大文字小文字を区別しない（GitHub の login と同じ） */
export function assigneeProblem(assignees: string[], me: string): AssigneeProblem | null {
  if (assignees.length === 0) return 'none';
  if (assignees.length > 1) return 'multiple';
  return same(assignees[0]!, me) ? null : 'other';
}

/** 理由の文 */
export function describeAssigneeProblem(problem: AssigneeProblem, assignees: string[]): string {
  const who = assignees.map((a) => `@${a}`).join(', ');
  if (problem === 'none') return '誰もアサインされていない';
  if (problem === 'other') return `ほかの人（${who}）がアサインされている`;
  return `2人以上（${who}）がアサインされている`;
}

/** 設定が有効か（true のときだけ。無ければ無効で、今までと同じ動き） */
export function requireAssignee(config: { requireAssignee?: boolean }): boolean {
  return config.requireAssignee === true;
}

/** 確かめに使う GitHub の読み出し（テストでは偽の実装） */
export interface AssigneeIo {
  /** 今の GitHub のユーザーの login（GET /user） */
  me(): Promise<string>;
  /** Issue か PR の assignees の login と、PR か */
  issue(n: number): Promise<{ assignees: string[]; pullRequest: boolean }>;
  /** PR が Close する Issue の番号 */
  closingIssues(pr: number): Promise<number[]>;
}

/**
 * claim・ensureOwnClaim の前の確かめ。設定が無効なら io を呼ばずに null。
 * n が PR なら、その PR が Close する Issue のそれぞれの Assignee で判定する（Issue が無ければ確かめられないので止める）
 */
export async function checkAssignee(io: AssigneeIo, config: { requireAssignee?: boolean }, n: number): Promise<string | null> {
  if (!requireAssignee(config)) return null;
  const me = await io.me();
  const target = await io.issue(n);
  let issues: { number: number; assignees: string[] }[];
  if (target.pullRequest) {
    const numbers = await io.closingIssues(n);
    if (numbers.length === 0) return `PR #${n}: Close する Issue が無いため、担当（Assignee）を確かめられません`;
    issues = [];
    for (const i of numbers) issues.push({ number: i, assignees: (await io.issue(i)).assignees });
  } else {
    issues = [{ number: n, assignees: target.assignees }];
  }
  for (const i of issues) {
    const problem = assigneeProblem(i.assignees, me);
    if (problem) return `#${i.number}: Assignee が自分（@${me}）1人ではありません（${describeAssigneeProblem(problem, i.assignees)}）。アサインは人が決めます（エージェントは自分をアサインしません）`;
  }
  return null;
}

/** fleet の候補から外す理由。自分1人なら null。me が分からなければ確かめられないので外す */
export function assigneeExclusion(assignees: string[], me: string | null): string | null {
  if (me === null) return '今の GitHub のユーザーが分からないため、Assignee を確かめられない';
  const problem = assigneeProblem(assignees, me);
  return problem ? `Assignee が自分1人ではない（${describeAssigneeProblem(problem, assignees)}）` : null;
}
