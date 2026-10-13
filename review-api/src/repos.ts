// 1つの Worker で受けるリポジトリの表（Cloudflare のダッシュボードの変数 REVIEW_REPOS。JSON の文字列）の読み取りと検査 parseRepoTable、
// REVIEW_REPOS が無いときに今の vars（ALLOWED_REPOS など）から組む表、行の引き当て findRepo、行から実行に要る値を選ぶ resolveRepoRuntime、
// redact に渡す秘密の一覧 collectSecrets、Webhook の秘密の名前の一覧 webhookSecretNames。
// 表には Secret の名前だけを書き、値は env[名前] から読む。誤りの文にはパスと期待する形だけを書き、値は入れない。
// import は ./config.ts の型だけ（Node と Workers の両方で動く）。
import type { IssueLink, RepoOverrides } from './config.ts';

/** Worker の環境変数。秘密は表が名指しする名前で読む */
export interface RepoEnv {
  REVIEW_REPOS?: string;
  ALLOWED_REPOS?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  REVIEW_APP_LOGIN?: string;
  GATE_APP_LOGIN?: string;
  [name: string]: unknown;
}

export interface RepoEntry {
  /** owner/repo（小文字） */
  fullName: string;
  /** 数字の文字列（今の vars から組んだ表では空文字もありうる） */
  installationId: string;
  app: { clientId: string; privateKeySecret: string; webhookSecret: string; login: string };
  gateAppLogin: string;
  anthropicKeySecret: string;
  overrides: RepoOverrides;
}

/** 鍵は owner/repo の小文字 */
export type RepoTable = Map<string, RepoEntry>;

export interface RepoRuntime {
  fullName: string;
  installationId: string;
  clientId: string;
  privateKey: string;
  anthropicKey: string;
  webhookSecretName: string;
  reviewAppLogin: string;
  gateAppLogin: string;
  overrides: RepoOverrides;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const ISSUE_LINKS: readonly string[] = ['closes', 'closes-or-refs'] satisfies IssueLink[];
const ROW_KEYS = ['installationId', 'app', 'gateAppLogin', 'anthropicKeySecret', 'budget', 'trigger'];
const APP_KEYS = ['clientId', 'privateKeySecret', 'webhookSecret', 'login'];
const BUDGET_KEYS = ['monthlyUsd', 'perReviewUsd'] as const;
const TRIGGER_KEYS = ['branchPrefix', 'requireClosesIssue', 'issueLink'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFullName = (s: string): boolean => {
  const parts = s.split('/');
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '';
};

function legacyTable(env: RepoEnv): RepoTable {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const table: RepoTable = new Map();
  for (const name of str(env.ALLOWED_REPOS).split(',')) {
    const fullName = name.trim().toLowerCase();
    if (fullName === '') continue;
    table.set(fullName, {
      fullName,
      installationId: str(env.GITHUB_INSTALLATION_ID),
      app: {
        clientId: str(env.GITHUB_APP_CLIENT_ID),
        privateKeySecret: 'GITHUB_APP_PRIVATE_KEY',
        webhookSecret: 'GITHUB_WEBHOOK_SECRET',
        login: str(env.REVIEW_APP_LOGIN),
      },
      gateAppLogin: str(env.GATE_APP_LOGIN),
      anthropicKeySecret: 'ANTHROPIC_API_KEY',
      overrides: {},
    });
  }
  return table;
}

/** 1行を検査して RepoEntry にする。誤りは errors に足し、null を返す */
function parseRow(path: string, fullName: string, row: unknown, errors: string[]): RepoEntry | null {
  const before = errors.length;
  const fail = (p: string, expected: string): void => {
    errors.push(`- ${p}: ${expected}`);
  };
  if (!isObject(row)) {
    fail(path, 'オブジェクト');
    return null;
  }
  const unknownKeys = (o: Record<string, unknown>, keys: string[], p: string): void => {
    const n = Object.keys(o).filter((k) => !keys.includes(k)).length;
    if (n > 0) fail(p, `知らない鍵がある（${n} 個）`);
  };
  const text = (o: Record<string, unknown>, key: string, p: string): string => {
    const v = o[key];
    if (typeof v === 'string' && v !== '') return v;
    fail(`${p}.${key}`, '空でない文字列');
    return '';
  };
  const secret = (o: Record<string, unknown>, key: string, p: string): string => {
    const v = o[key];
    if (typeof v === 'string' && SECRET_NAME.test(v)) return v;
    fail(`${p}.${key}`, `${SECRET_NAME.source} の名前`);
    return '';
  };
  unknownKeys(row, ROW_KEYS, path);

  let installationId = '';
  const id = row.installationId;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) installationId = String(id);
  else if (typeof id === 'string' && /^\d+$/.test(id) && !/^0+$/.test(id)) installationId = id;
  else fail(`${path}.installationId`, '正の整数か数字の文字列');

  let app: RepoEntry['app'] = { clientId: '', privateKeySecret: '', webhookSecret: '', login: '' };
  if (!isObject(row.app)) fail(`${path}.app`, 'オブジェクト');
  else {
    const p = `${path}.app`;
    unknownKeys(row.app, APP_KEYS, p);
    app = {
      clientId: text(row.app, 'clientId', p),
      privateKeySecret: secret(row.app, 'privateKeySecret', p),
      webhookSecret: secret(row.app, 'webhookSecret', p),
      login: text(row.app, 'login', p),
    };
  }
  const gateAppLogin = text(row, 'gateAppLogin', path);
  const anthropicKeySecret = secret(row, 'anthropicKeySecret', path);

  const overrides: RepoOverrides = {};
  if (row.budget !== undefined) {
    const p = `${path}.budget`;
    if (!isObject(row.budget)) fail(p, 'オブジェクト');
    else {
      unknownKeys(row.budget, [...BUDGET_KEYS], p);
      const budget: NonNullable<RepoOverrides['budget']> = {};
      for (const key of BUDGET_KEYS) {
        const v = row.budget[key];
        if (v === undefined) continue;
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) budget[key] = v;
        else fail(`${p}.${key}`, '有限の正の数');
      }
      overrides.budget = budget;
    }
  }
  if (row.trigger !== undefined) {
    const p = `${path}.trigger`;
    if (!isObject(row.trigger)) fail(p, 'オブジェクト');
    else {
      const t = row.trigger;
      unknownKeys(t, TRIGGER_KEYS, p);
      const trigger: NonNullable<RepoOverrides['trigger']> = {};
      if (t.branchPrefix !== undefined) {
        if (typeof t.branchPrefix === 'string') trigger.branchPrefix = t.branchPrefix;
        else fail(`${p}.branchPrefix`, '文字列');
      }
      if (t.requireClosesIssue !== undefined) {
        if (typeof t.requireClosesIssue === 'boolean') trigger.requireClosesIssue = t.requireClosesIssue;
        else fail(`${p}.requireClosesIssue`, '真偽値');
      }
      if (t.issueLink !== undefined) {
        if (typeof t.issueLink === 'string' && ISSUE_LINKS.includes(t.issueLink)) trigger.issueLink = t.issueLink as IssueLink;
        else fail(`${p}.issueLink`, ISSUE_LINKS.join(' か '));
      }
      overrides.trigger = trigger;
    }
  }
  if (errors.length > before) return null;
  return { fullName, installationId, app, gateAppLogin, anthropicKeySecret, overrides };
}

/**
 * REVIEW_REPOS が無い・空白だけなら今の vars から表を組む（source は legacy。識別子が空でも誤りにしない）。
 * あればそれだけを使い（source は table）、誤りは全部集めて返す。誤りがあれば表は空（一部の行だけで動かさない）
 */
export function parseRepoTable(env: RepoEnv): { table: RepoTable; errors: string[]; source: 'table' | 'legacy' } {
  const raw = typeof env.REVIEW_REPOS === 'string' ? env.REVIEW_REPOS : '';
  if (raw.trim() === '') return { table: legacyTable(env), errors: [], source: 'legacy' };
  const fail = (errors: string[]) => ({ table: new Map() as RepoTable, errors, source: 'table' as const });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(['- REVIEW_REPOS: JSON として読めない']);
  }
  if (!isObject(parsed)) return fail(['- REVIEW_REPOS: owner/repo を鍵にしたオブジェクト']);
  const errors: string[] = [];
  const table: RepoTable = new Map();
  const seen = new Set<string>();
  for (const [index, [key, row]] of Object.entries(parsed).entries()) {
    if (!isFullName(key)) {
      errors.push(`- #${index}: 鍵は owner/repo の形`);
      continue;
    }
    const fullName = key.toLowerCase();
    if (seen.has(fullName)) {
      errors.push(`- ${fullName}: 同じリポジトリが2回ある（大文字小文字は区別しない）`);
      continue;
    }
    seen.add(fullName);
    const entry = parseRow(key, fullName, row, errors);
    if (entry !== null) table.set(fullName, entry);
  }
  return errors.length > 0 ? fail(errors) : { table, errors: [], source: 'table' };
}

export function findRepo(table: RepoTable, fullName: string): RepoEntry | null {
  return table.get(fullName.toLowerCase()) ?? null;
}

/** env[name] が文字列ならその値、ほかは空文字 */
export function secretValue(env: RepoEnv, name: string): string {
  const v = env[name];
  return typeof v === 'string' ? v : '';
}

/** 行から実行に要る値を選ぶ。ほかの行の値は使わない。表に無ければ null */
export function resolveRepoRuntime(env: RepoEnv, table: RepoTable, fullName: string): RepoRuntime | null {
  const entry = findRepo(table, fullName);
  if (entry === null) return null;
  return {
    fullName: entry.fullName,
    installationId: entry.installationId,
    clientId: entry.app.clientId,
    privateKey: secretValue(env, entry.app.privateKeySecret),
    anthropicKey: secretValue(env, entry.anthropicKeySecret),
    webhookSecretName: entry.app.webhookSecret,
    reviewAppLogin: entry.app.login,
    gateAppLogin: entry.gateAppLogin,
    overrides: entry.overrides,
  };
}

/** すべての行が名指しする Secret の値（空を除き、重複なし）。ログ・コメント・KV の記録から伏せるために redact に渡す */
export function collectSecrets(env: RepoEnv, table: RepoTable): string[] {
  const out = new Set<string>();
  for (const e of table.values()) {
    for (const name of [e.app.privateKeySecret, e.app.webhookSecret, e.anthropicKeySecret]) {
      const v = secretValue(env, name);
      if (v !== '') out.add(v);
    }
  }
  return [...out];
}

/** すべての行の Webhook の秘密の名前（出てくる順、重複なし） */
export function webhookSecretNames(table: RepoTable): string[] {
  return [...new Set([...table.values()].map((e) => e.app.webhookSecret))];
}
