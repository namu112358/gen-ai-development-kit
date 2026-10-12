import { readFileSync } from 'node:fs';
import { protectedLabelsOf } from '../../../../.claude/hooks/guard.ts';
import { checkAssignee } from '../../../lib/assignee.ts';
import * as configLib from '../../../lib/config.ts';
import type { HarnessConfig } from '../../../lib/config.ts';
import { restCreateDraftPr, restCreateIssue } from '../../../lib/gh-rest-create.ts';
import { type AgentCommand, assigneeIo, config, currentSession, fail } from '../cli.ts';

/**
 * Issue と Draft PR を GraphQL を使わず REST だけで作る（Issue #713）。守り（保護ラベルと :exempt のラベル、agentBranchPrefix、
 * 本文の Closes / Refs、このセッションの着手宣言）は書き込みの前に確かめ、当たれば何も書かずに理由を出して止まる。出力は JSON。
 *
 *   node harness/scripts/agent.ts rest-create issue --title <題> --body-file <ファイル> [--label <ラベル>]...
 *   node harness/scripts/agent.ts rest-create draft-pr <Issue番号> --head <ブランチ> --title <題> --body-file <ファイル> [--base <ブランチ>] [--label <ラベル>]...
 *                                                           PR は Draft に固定（base の既定は defaultBranch）
 */

const USAGE = 'rest-create issue --title <題> --body-file <ファイル> [--label <ラベル>]... | draft-pr <Issue番号> --head <ブランチ> --title <題> --body-file <ファイル> [--base <ブランチ>] [--label <ラベル>]...';

/** 作るときに拒むラベルの一覧。guard の protectedLabelsOf をそのまま使う（設定でラベルの名前を変えても guard と同じ一覧） */
export function createProtectedLabels(cfg: HarnessConfig): string[] {
  return protectedLabelsOf(cfg, configLib);
}

function parseArgs(args: string[], single: string[]): { positional: string[]; values: Map<string, string>; labels: string[] } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const labels: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--label' || single.includes(a)) {
      const v = args[++i];
      if (v === undefined) fail([`${a} に値がありません`, USAGE]);
      if (a === '--label') labels.push(v);
      else if (values.has(a)) fail([`${a} は1つだけです`, USAGE]);
      else values.set(a, v);
    } else if (a.startsWith('--')) fail([`知らないオプションです: ${a}`, USAGE]);
    else positional.push(a);
  }
  return { positional, values, labels };
}

function required(values: Map<string, string>, name: string): string {
  const v = values.get(name);
  if (v === undefined || v.trim() === '') fail([`${name} が要ります`, USAGE]);
  return v;
}

export const commands: AgentCommand[] = [
  {
    name: 'rest-create',
    run: async (args, ctx) => {
      const [sub, ...rest] = args;
      const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
      const protectedLabels = createProtectedLabels(config);
      if (sub === 'issue') {
        const { positional, values, labels } = parseArgs(rest, ['--title', '--body-file']);
        if (positional.length > 0) fail([USAGE]);
        const title = required(values, '--title');
        const body = readFileSync(required(values, '--body-file'), 'utf8');
        const r = await restCreateIssue(ctx.gh(), { title, body, labels }, protectedLabels);
        if (!r.ok) fail(r.errors);
        return print({ number: r.number, url: r.url });
      }
      if (sub === 'draft-pr') {
        const { positional, values, labels } = parseArgs(rest, ['--head', '--base', '--title', '--body-file']);
        if (positional.length !== 1 || !/^\d+$/.test(positional[0]!)) fail([USAGE]);
        const issue = Number(positional[0]);
        const head = required(values, '--head');
        const title = required(values, '--title');
        const body = readFileSync(required(values, '--body-file'), 'utf8');
        const base = values.get('--base');
        const gh = ctx.gh();
        const r = await restCreateDraftPr(gh, { issue, head, ...(base !== undefined ? { base } : {}), title, body, labels }, {
          prefix: config.agentBranchPrefix, defaultBranch: config.defaultBranch, protectedLabels,
          session: currentSession(), assignee: () => checkAssignee(assigneeIo(gh), config, issue),
        });
        if (!r.ok) fail(r.errors);
        return print({ number: r.number, url: r.url, isDraft: true });
      }
      fail([sub === undefined ? 'サブコマンドがありません' : `知らないサブコマンドです: ${sub}`, USAGE]);
    },
  },
];
