// 手元の wrangler dev に、署名つきの pull_request の Webhook を送る確かめ用の送り手。
// 使い方: node scripts/send-webhook.ts <action> <owner/repo> <PR 番号> <head> [--url <URL>] [--ref <ブランチ>] [--closes <Issue 番号>]
// 秘密（GITHUB_WEBHOOK_SECRET）と installation id（GITHUB_INSTALLATION_ID）は review-api/.dev.vars か環境変数から読む。
// Node だけで動き、src は import しない。
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface WebhookInput {
  action: string;
  fullName: string;
  pr: number;
  headSha: string;
  ref: string;
  closes?: number;
  installationId?: number;
  secret: string;
}

const USAGE =
  '使い方: node scripts/send-webhook.ts <action> <owner/repo> <PR 番号> <head> [--url <URL>] [--ref <ブランチ>] [--closes <Issue 番号>]';

export function buildWebhookRequest(input: WebhookInput): { body: string; headers: Record<string, string> } {
  const event = {
    action: input.action,
    sender: { type: 'User', login: 'send-webhook' },
    repository: { full_name: input.fullName },
    ...(input.installationId === undefined ? {} : { installation: { id: input.installationId } }),
    pull_request: {
      number: input.pr,
      state: 'open',
      head: { sha: input.headSha, ref: input.ref },
      body: input.closes === undefined ? '' : `Closes #${input.closes}`,
    },
  };
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'review-api-send-webhook',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', input.secret).update(body).digest('hex'),
    },
  };
}

function readDevVars(path: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(path)) return vars;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    vars.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return vars;
}

function positiveInt(text: string): number | null {
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
}

function fail(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: 'string' },
        ref: { type: 'string' },
        closes: { type: 'string' },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const [action, fullName, prText, headSha] = parsed.positionals;
  if (parsed.positionals.length !== 4 || action === undefined || fullName === undefined || prText === undefined || headSha === undefined) {
    return fail('位置引数は <action> <owner/repo> <PR 番号> <head> の4つです');
  }
  if (fullName.split('/').length !== 2 || fullName.split('/').some((part) => part === '')) {
    return fail(`owner/repo の形ではありません：${fullName}`);
  }
  const pr = positiveInt(prText);
  if (pr === null) return fail(`PR 番号が正の整数ではありません：${prText}`);
  let closes: number | undefined;
  if (parsed.values.closes !== undefined) {
    const n = positiveInt(parsed.values.closes);
    if (n === null) return fail(`--closes が正の整数ではありません：${parsed.values.closes}`);
    closes = n;
  }

  const devVars = readDevVars(resolve(fileURLToPath(import.meta.url), '../../.dev.vars'));
  const pick = (key: string): string => {
    const fromFile = devVars.get(key);
    if (fromFile !== undefined && fromFile !== '') return fromFile;
    return (process.env[key] ?? '').trim();
  };
  const secret = pick('GITHUB_WEBHOOK_SECRET');
  if (secret === '') {
    console.error('GITHUB_WEBHOOK_SECRET が .dev.vars にも環境変数にもありません');
    return 1;
  }
  const installationId = positiveInt(pick('GITHUB_INSTALLATION_ID')) ?? undefined;

  const url = parsed.values.url ?? 'http://localhost:8787/webhook';
  const { body, headers } = buildWebhookRequest({
    action,
    fullName,
    pr,
    headSha,
    ref: parsed.values.ref ?? 'claude/send-webhook',
    closes,
    installationId,
    secret,
  });
  console.log(`送り先 ${url}：${action} ${fullName} #${pr} head=${headSha}`);
  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    console.log(`${res.status} ${res.statusText}`);
    console.log(await res.text());
    return res.status >= 200 && res.status < 300 ? 0 : 1;
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const reason = typeof cause?.code === 'string' ? cause.code : error instanceof Error ? error.message : String(error);
    console.error(`${url} に送れませんでした：${reason}。npm run dev で wrangler dev を起こしたか確かめてください`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`予期せぬエラー：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
