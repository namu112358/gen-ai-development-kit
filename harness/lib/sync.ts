/**
 * 導入先に配布物を写す sync の判断（上書き・新規・unchanged・除外・settings の merge・kit に無い managed の警告・写した版の記録）を決める純粋関数（Epic #642 の #650）。
 * git・GitHub・ファイルには触らず、入力はすべて値と関数で受ける。CLI は #651 で足す。
 */
import { isDeepStrictEqual } from 'node:util';
import { contentVersion } from './harness-drift.ts';
import { globToRegExp } from './scope.ts';
import { hasDefaultBranchPlaceholder, renderDeny } from './settings-deny.ts';

/** harness/managed.json の中身 */
export interface ManagedJson {
  /** 無視する */
  $comment?: string;
  managed: string[];
  /** managed に当たっても配らないもの（#643 で足す欄。無ければ空） */
  exclude?: string[];
  projectOwned: { path: string; template: string }[];
  settingsKeys: string[];
  /** permissions.allow に足す行（和集合。無ければ空） */
  settingsAllow?: string[];
}

export interface SyncInput {
  managed: ManagedJson;
  /** harness/managed.local.json の中身。無ければ null */
  local: { exclude: string[] } | null;
  /** kit の全ファイル（managed に当たらないものも含む） */
  kitFiles: Map<string, Uint8Array>;
  /** 導入先の全ファイルのパス（リポジトリルートからの相対、/ 区切り）。managed の絞り込みは planSync が行う */
  targetList(): string[];
  /** 導入先のファイルの中身。無ければ null */
  targetRead(path: string): Uint8Array | null;
  /** 導入先の .claude/settings.json の中身。無ければ null */
  targetSettings: unknown | null;
  kit: { repository: string; ref: string; sha: string };
  now: Date;
  /** 真のときだけ、kit に無い managed のファイルを remove に入れる */
  prune: boolean;
  /** 導入先の既定ブランチ。deny の雛形の {{defaultBranch}} を埋める */
  targetDefaultBranch: string;
}

export interface SyncPlan {
  overwrite: string[];
  /** projectOwned と managed を区別しない。CLI は managed.projectOwned を path で引く */
  create: string[];
  unchanged: string[];
  excluded: string[];
  /** 導入先の managed に当たるファイルで kit に無いもの（警告） */
  missingInKit: string[];
  /** prune のときだけ。無ければ空 */
  remove: string[];
  settings: { merged: Record<string, unknown>; changedKeys: string[] };
  kitVersion: { repository: string; ref: string; sha: string; syncedAt: string };
}

const KIT_SETTINGS_PATH = '.claude/settings.json';
const DENY_TEMPLATE_PATH = 'harness/templates/claude-settings.deny.json';

const matcher = (patterns: string[]): ((path: string) => boolean) => {
  const res = patterns.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
};

/** managed の glob に当たり、exclude に当たらないか */
export function isManaged(managed: string[], exclude: string[], path: string): boolean {
  return matcher(managed)(path) && !matcher(exclude)(path);
}

const ALLOW_KEY = 'permissions.allow';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** キーのパス（a.b.c）の値。途中が無ければ undefined */
const getPath = (obj: Record<string, unknown>, parts: string[]): unknown => {
  let cur: unknown = obj;
  for (const p of parts) {
    if (!isObject(cur) || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
};

/** キーのパスに値を置く（途中のオブジェクトは作る。オブジェクトでなければ置き換える） */
const setPath = (obj: Record<string, unknown>, parts: string[], value: unknown): void => {
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = structuredClone(value);
};

/**
 * keys のパスごとに kit の値で丸ごと置き換え（配列は merge しない）、ほかのキーは target のまま。
 * kit に無いパスは触らない。changedKeys は keys に書かれた順。target がオブジェクトでなければ throw。
 * ただし permissions.allow だけは和集合：kit の値は見ず、導入先の配列に allowRows のうち無い行を足す（導入先の行と順は残す）。
 * 導入先の permissions.allow が配列でなければ throw
 */
export function mergeSettings(target: unknown, kit: unknown, keys: string[], allowRows: readonly string[] = []): { merged: Record<string, unknown>; changedKeys: string[] } {
  if (!isObject(target)) throw new Error('導入先の .claude/settings.json がオブジェクトではない');
  if (!isObject(kit)) throw new Error('kit の .claude/settings.json がオブジェクトではない');
  const merged = structuredClone(target);
  const changedKeys: string[] = [];
  for (const key of keys) {
    const parts = key.split('.');
    if (key === ALLOW_KEY) {
      const current = getPath(merged, parts);
      if (current !== undefined && !Array.isArray(current)) throw new Error('導入先の .claude/settings.json の permissions.allow が配列ではない');
      const have: unknown[] = current === undefined ? [] : current;
      const add = [...new Set(allowRows)].filter((row) => !have.includes(row));
      if (add.length === 0) continue;
      setPath(merged, parts, [...have, ...add]);
      changedKeys.push(key);
      continue;
    }
    const value = getPath(kit, parts);
    if (value === undefined) continue;
    if (isDeepStrictEqual(getPath(merged, parts), value)) continue;
    setPath(merged, parts, value);
    changedKeys.push(key);
  }
  return { merged, changedKeys };
}

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** deny の雛形が {{defaultBranch}} の行を持つなら、kit の settings の permissions.deny を雛形を導入先の既定ブランチで埋めたものに置き換えた複製を返す。無ければそのまま */
const withRenderedDeny = (kitSettings: unknown, input: SyncInput): unknown => {
  const rawTemplate = input.kitFiles.get(DENY_TEMPLATE_PATH);
  if (rawTemplate === undefined || !isObject(kitSettings)) return kitSettings;
  let template: unknown;
  try {
    template = JSON.parse(Buffer.from(rawTemplate).toString('utf8'));
  } catch (e) {
    throw new Error(`kit の ${DENY_TEMPLATE_PATH} を JSON として読めない: ${(e as Error).message}`);
  }
  const deny = isObject(template) && isObject(template.permissions) ? template.permissions.deny : undefined;
  if (!Array.isArray(deny) || !deny.every((r) => typeof r === 'string') || !hasDefaultBranchPlaceholder(deny)) return kitSettings;
  const clone = structuredClone(kitSettings);
  setPath(clone, ['permissions', 'deny'], renderDeny(deny, input.targetDefaultBranch));
  return clone;
};

const planSettings = (input: SyncInput): SyncPlan['settings'] => {
  const { targetSettings } = input;
  if (targetSettings !== null && !isObject(targetSettings)) throw new Error('導入先の .claude/settings.json がオブジェクトではない');
  const raw = input.kitFiles.get(KIT_SETTINGS_PATH);
  if (raw === undefined) return { merged: targetSettings === null ? {} : structuredClone(targetSettings), changedKeys: [] };
  let kitSettings: unknown;
  try {
    kitSettings = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch (e) {
    throw new Error(`kit の ${KIT_SETTINGS_PATH} を JSON として読めない: ${(e as Error).message}`);
  }
  const kitForMerge = withRenderedDeny(kitSettings, input);
  const allowRows = input.managed.settingsAllow ?? [];
  if (!Array.isArray(allowRows) || !allowRows.every((r) => typeof r === 'string')) throw new Error('managed.json の settingsAllow が文字列の配列ではない');
  return mergeSettings(targetSettings ?? {}, kitForMerge, input.managed.settingsKeys, allowRows);
};

/** sync で何をするかを決める */
export function planSync(input: SyncInput): SyncPlan {
  const { managed } = input;
  const inManaged = (path: string) => isManaged(managed.managed, managed.exclude ?? [], path);
  const isLocalExcluded = matcher(input.local?.exclude ?? []);
  const projectOwnedPaths = new Set(managed.projectOwned.map((p) => p.path));
  const targetPaths = new Set(input.targetList());

  const overwrite: string[] = [];
  const create: string[] = [];
  const unchanged: string[] = [];
  const excluded: string[] = [];
  const missingInKit: string[] = [];

  for (const [path, content] of input.kitFiles) {
    if (projectOwnedPaths.has(path) || !inManaged(path)) continue;
    if (isLocalExcluded(path)) {
      excluded.push(path);
      continue;
    }
    const current = targetPaths.has(path) ? input.targetRead(path) : null;
    if (current === null) create.push(path);
    else if (contentVersion(current) === contentVersion(content)) unchanged.push(path);
    else overwrite.push(path);
  }

  for (const { path, template } of managed.projectOwned) {
    if (targetPaths.has(path)) continue;
    if (!input.kitFiles.has(template)) throw new Error(`projectOwned の ${path} の雛形 ${template} が kit に無い`);
    if (isLocalExcluded(path)) excluded.push(path);
    else create.push(path);
  }

  for (const path of targetPaths) {
    if (projectOwnedPaths.has(path) || input.kitFiles.has(path) || !inManaged(path)) continue;
    if (isLocalExcluded(path)) excluded.push(path);
    else missingInKit.push(path);
  }

  return {
    overwrite: sorted(overwrite),
    create: sorted(create),
    unchanged: sorted(unchanged),
    excluded: sorted(excluded),
    missingInKit: sorted(missingInKit),
    remove: input.prune ? sorted(missingInKit) : [],
    settings: planSettings(input),
    kitVersion: { repository: input.kit.repository, ref: input.kit.ref, sha: input.kit.sha, syncedAt: input.now.toISOString() },
  };
}
