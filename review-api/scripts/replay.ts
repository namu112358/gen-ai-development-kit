// 過去の PR のローカルの判定（ブロッキング指摘のある agent-verdict）の head を API のレビューで流し直し、並べた表と PR ごとの JSON を書く（docs/review-api.md の節11）。
// 使い方: node scripts/replay.ts <owner/repo> --prs <1001-1040 か 1001,1005> [--max-usd <USD>] [--out <ディレクトリ>] [--list]
// 環境変数は GITHUB_TOKEN（必須）と、--list でなければ ANTHROPIC_API_KEY（必須）。--list は対象と見込みの USD だけを出し、Claude を呼ばない。
// Node だけで動く。SDK を import するのはこの script で、ロジックは src/replay-compare.ts に置き、ここは引数を読んでクライアントを渡すだけにする。
import Anthropic from '@anthropic-ai/sdk';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import reviewConfigJson from '../review.config.json' with { type: 'json' };
import type { Message, MessagesClient, MessagesParams } from '../src/claude.ts';
import { loadReviewConfig } from '../src/config.ts';
import { createGitHubClient } from '../src/github.ts';
import { redact } from '../src/redact.ts';
import { listReplayTargets, runReplayCompare, type ReplayFs } from '../src/replay-compare.ts';

const USAGE = '使い方: node scripts/replay.ts <owner/repo> --prs <1001-1040 か 1001,1005> [--max-usd <USD>] [--out <ディレクトリ>] [--list]';

/** 1001-1040 の範囲か 1001,1005 の列挙。正の整数、範囲の始め ≤ 終わり、重複は1回 */
export function parsePrs(text: string): number[] | null {
  const positive = (t: string): number | null => (/^[1-9][0-9]*$/.test(t) ? Number(t) : null);
  const range = /^([0-9]+)-([0-9]+)$/.exec(text);
  if (range !== null) {
    const from = positive(range[1]!);
    const to = positive(range[2]!);
    if (from === null || to === null || from > to) return null;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const out: number[] = [];
  for (const part of text.split(',')) {
    const n = positive(part.trim());
    if (n === null) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function fail(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return 1;
}

function anthropicClient(apiKey: string): MessagesClient {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async create(params: MessagesParams): Promise<Message> {
      // askWithTools は同じ配列を渡して後で push するので、写して渡す
      const message = await client.messages.create({ ...params, messages: [...params.messages] } as unknown as Anthropic.MessageCreateParamsNonStreaming);
      return message as unknown as Message;
    },
  };
}

const nodeFs: ReplayFs = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async writeNew(path, text) {
    await writeFile(path, text, { flag: 'wx' });
  },
};

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        prs: { type: 'string' },
        'max-usd': { type: 'string' },
        out: { type: 'string' },
        list: { type: 'boolean' },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const [fullName] = parsed.positionals;
  if (parsed.positionals.length !== 1 || fullName === undefined) return fail('位置引数は <owner/repo> の1つです');
  const [owner, repo] = fullName.split('/');
  if (fullName.split('/').length !== 2 || !owner || !repo) return fail(`owner/repo の形ではありません：${fullName}`);
  const prs = parsed.values.prs === undefined ? null : parsePrs(parsed.values.prs);
  if (prs === null) return fail(`--prs が読めません：${parsed.values.prs ?? '（無し）'}`);
  const list = parsed.values.list === true;
  let maxUsd = 0;
  let outDir = '';
  if (!list) {
    maxUsd = Number(parsed.values['max-usd']);
    if (parsed.values['max-usd'] === undefined || !Number.isFinite(maxUsd) || maxUsd <= 0) return fail('--max-usd は有限の正の数で渡します');
    if (parsed.values.out === undefined || parsed.values.out === '') return fail('--out を渡します');
    outDir = parsed.values.out;
  }

  const token = (process.env.GITHUB_TOKEN ?? '').trim();
  if (token === '') return fail('GITHUB_TOKEN がありません');
  const apiKey = list ? '' : (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!list && apiKey === '') return fail('ANTHROPIC_API_KEY がありません');
  const secrets = [token, apiKey];
  const print = (line: string): void => console.log(redact(line, secrets));

  let appSlug: unknown;
  try {
    const harnessConfig = JSON.parse(await readFile(resolve(fileURLToPath(import.meta.url), '../../../harness.config.json'), 'utf8')) as { appSlug?: unknown };
    appSlug = harnessConfig.appSlug;
  } catch (error) {
    console.error(redact(`harness.config.json を読めません：${error instanceof Error ? error.message : String(error)}`, secrets));
    return 1;
  }
  if (typeof appSlug !== 'string' || appSlug === '') {
    console.error('harness.config.json の appSlug が読めません');
    return 1;
  }

  const config = loadReviewConfig(reviewConfigJson);
  const base = {
    github: { reader: async () => createGitHubClient({ token, owner, repo }) },
    now: () => Date.now(),
    log: print,
    secrets,
  };
  const params = { owner, repo, prs, gateAppLogin: `${appSlug}[bot]`, config };

  if (list) {
    const { rows, totalUsd } = await listReplayTargets(base, params);
    for (const r of rows) {
      print('reason' in r ? `#${r.pr} 対象外：${r.reason}` : `#${r.pr} ${r.headSha.slice(0, 7)} 見込み ${r.estimatedUsd === null ? '—' : `$${r.estimatedUsd.toFixed(4)}`}`);
    }
    print(`対象 ${rows.filter((r) => !('reason' in r)).length} 件、見込みの合計 ${totalUsd === null ? '—（出せない PR がある）' : `$${totalUsd.toFixed(4)}`}`);
    return 0;
  }

  const result = await runReplayCompare({ ...base, claude: anthropicClient(apiKey), fs: nodeFs }, { ...params, maxUsd, outDir });
  if (result.outcome === 'exists') {
    console.error(redact(`既に summary.md があります（${result.path}）。別の --out を渡してください`, secrets));
    return 1;
  }
  print(`${result.rows.length} 件を表にしました（使った USD $${result.spentUsd.toFixed(4)}）：${outDir.replace(/\/+$/, '')}/summary.md`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(redact(`予期せぬエラー：${error instanceof Error ? error.message : String(error)}`, [process.env.GITHUB_TOKEN, process.env.ANTHROPIC_API_KEY]));
      process.exitCode = 1;
    },
  );
}
