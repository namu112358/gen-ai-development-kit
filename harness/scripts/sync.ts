/**
 * kit の版（タグ・ブランチ・SHA）を指定して、配布物を導入先に写す。判断は `harness/lib/sync.ts` の planSync に任せ、ここは引数・git・ファイル・表示だけを持つ。
 *
 *   node harness/scripts/sync.ts <ref> [--from <owner/repo|URL|パス>] [--dry-run] [--prune]
 *
 * - --from：kit の置き場。無ければ `harness/kit-version.json` の `repository`。`://` を含むかパスとして存在すればそのまま、そうでなければ `https://github.com/<owner/repo>.git`
 * - --dry-run：上書き・新規・除外・kit に無い managed・settings の変更を出して終わる（何も書かない）
 * - --prune：kit に無い managed のファイルを消す（無ければ警告だけ）
 *
 * kit は `git fetch` で導入先の object store に取り込んで読む。GitHub の API は呼ばない。導入先で git が追跡していないファイルは missingInKit・remove に出ない。
 * 写した版は `harness/kit-version.json`（repository・ref・sha・syncedAt）に残す。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isManaged, planSync, type ManagedJson, type SyncInput, type SyncPlan } from '../lib/sync.ts';

const MAX_BUFFER = 256 * 1024 * 1024;
const MANAGED_PATH = 'harness/managed.json';
const LOCAL_PATH = 'harness/managed.local.json';
const SETTINGS_PATH = '.claude/settings.json';
const VERSION_PATH = 'harness/kit-version.json';

const USAGE = 'usage: node harness/scripts/sync.ts <ref> [--from <owner/repo|URL|パス>] [--dry-run] [--prune]';

class Stop extends Error {}

const run = (cwd: string, args: string[], input?: string) =>
  spawnSync('git', args, { cwd, maxBuffer: MAX_BUFFER, input });

export function kitUrl(from: string): string {
  return from.includes('://') || existsSync(from) ? from : `https://github.com/${from}.git`;
}

/** kit を取り込み、commit の SHA を返す（タグ → ブランチ → SHA の順） */
export function fetchKit(root: string, url: string, ref: string): string {
  const errors: string[] = [];
  for (const spec of [`refs/tags/${ref}`, `refs/heads/${ref}`, ref]) {
    const f = run(root, ['fetch', '--no-tags', url, spec]);
    if (f.status === 0) {
      const p = run(root, ['rev-parse', 'FETCH_HEAD^{commit}']);
      if (p.status !== 0) throw new Stop(`FETCH_HEAD の commit を読めません: ${p.stderr}`);
      return p.stdout.toString('utf8').trim();
    }
    errors.push(`${spec}: ${f.stderr.toString('utf8').trim()}`);
  }
  throw new Stop(`kit ${url} の ${ref} を取り込めません:\n${errors.join('\n')}`);
}

/** sha の tree から、managed に当たるファイルと settings・雛形の中身を読む */
export function readKitTree(root: string, sha: string, managed: ManagedJson): Map<string, Uint8Array> {
  const ls = run(root, ['ls-tree', '-r', '-z', sha]);
  if (ls.status !== 0) throw new Stop(`kit の tree を読めません: ${ls.stderr}`);
  const wanted = new Set([SETTINGS_PATH, ...managed.projectOwned.map((p) => p.template)]);
  const entries: { path: string; oid: string }[] = [];
  for (const line of ls.stdout.toString('utf8').split('\0')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (!m) continue;
    const path = m[2]!;
    if (wanted.has(path) || isManaged(managed.managed, managed.exclude ?? [], path)) entries.push({ oid: m[1]!, path });
  }
  const files = new Map<string, Uint8Array>();
  if (entries.length === 0) return files;
  const cat = run(root, ['cat-file', '--batch'], entries.map((e) => `${e.oid}\n`).join(''));
  if (cat.status !== 0) throw new Stop(`kit のファイルを読めません: ${cat.stderr}`);
  const buf = cat.stdout;
  let pos = 0;
  for (const e of entries) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Stop('git cat-file の出力が壊れています');
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isInteger(size)) throw new Stop('git cat-file の出力が壊れています');
    files.set(e.path, new Uint8Array(buf.subarray(nl + 1, nl + 1 + size)));
    pos = nl + 1 + size + 1;
  }
  return files;
}

const readJson = (path: string, what: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Stop(`${what} を JSON として読めません: ${(e as Error).message}`);
  }
};

const readOptionalJson = (path: string, what: string): unknown | null => (existsSync(path) ? readJson(path, what) : null);

const list = (title: string, paths: string[], note = ''): void => {
  if (paths.length === 0) return;
  console.log(`${title} (${paths.length})${note}`);
  for (const p of paths) console.log(`  ${p}`);
};

function show(plan: SyncPlan, prune: boolean): void {
  const kv = plan.kitVersion;
  console.log(`kit: ${kv.repository} ${kv.ref} (${kv.sha})`);
  list('上書き', plan.overwrite);
  list('新規', plan.create);
  console.log(`変更なし (${plan.unchanged.length})`);
  list('除外 (managed.local.json)', plan.excluded);
  list('kit に無い managed のファイル', plan.missingInKit, prune ? '' : '。消すには --prune');
  list('削除', plan.remove);
  list('settings.json の merge', plan.settings.changedKeys);
}

const writeIfChanged = (root: string, path: string, content: string | Uint8Array): void => {
  const abs = join(root, path);
  const next = Buffer.from(content);
  if (existsSync(abs) && readFileSync(abs).equals(next)) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next);
};

export function main(argv: string[]): number {
  try {
    let ref: string | undefined;
    let from: string | undefined;
    let dryRun = false;
    let prune = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '--dry-run') dryRun = true;
      else if (a === '--prune') prune = true;
      else if (a === '--from') from = argv[++i];
      else if (a.startsWith('--') || ref !== undefined) throw new Stop(`知らない引数です: ${a}\n${USAGE}`);
      else ref = a;
    }
    if (!ref) throw new Stop(USAGE);
    if (argv.includes('--from') && !from) throw new Stop(`--from に値がありません\n${USAGE}`);

    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { maxBuffer: MAX_BUFFER });
    if (top.status !== 0) throw new Stop('git のリポジトリではありません');
    const root = top.stdout.toString('utf8').trim();

    if (!from) {
      const v = readOptionalJson(join(root, VERSION_PATH), VERSION_PATH) as { repository?: unknown } | null;
      if (typeof v?.repository === 'string') from = v.repository;
    }
    if (!from) throw new Stop(`--from が無く、${VERSION_PATH} にも repository がありません`);

    const sha = fetchKit(root, kitUrl(from), ref);
    const managedBlob = run(root, ['cat-file', 'blob', `${sha}:${MANAGED_PATH}`]);
    if (managedBlob.status !== 0) throw new Stop(`kit に ${MANAGED_PATH} がありません`);
    let managed: ManagedJson;
    try {
      managed = JSON.parse(managedBlob.stdout.toString('utf8')) as ManagedJson;
    } catch (e) {
      throw new Stop(`kit の ${MANAGED_PATH} を JSON として読めません: ${(e as Error).message}`);
    }
    const kitFiles = readKitTree(root, sha, managed);

    const lsFiles = run(root, ['ls-files', '-z']);
    if (lsFiles.status !== 0) throw new Stop(`git ls-files に失敗しました: ${lsFiles.stderr}`);
    const tracked = lsFiles.stdout.toString('utf8').split('\0').filter(Boolean);

    const input: SyncInput = {
      managed,
      local: readOptionalJson(join(root, LOCAL_PATH), LOCAL_PATH) as { exclude: string[] } | null,
      kitFiles,
      targetList: () => tracked,
      targetRead: (p) => (existsSync(join(root, p)) ? new Uint8Array(readFileSync(join(root, p))) : null),
      targetSettings: readOptionalJson(join(root, SETTINGS_PATH), SETTINGS_PATH),
      kit: { repository: from, ref, sha },
      now: new Date(),
      prune,
    };
    const plan = planSync(input);
    show(plan, prune);
    if (dryRun) return 0;

    const templates = new Map(managed.projectOwned.map((p) => [p.path, p.template]));
    for (const path of [...plan.overwrite, ...plan.create]) {
      const source = templates.get(path) ?? path;
      writeIfChanged(root, path, kitFiles.get(source)!);
    }
    const settingsExists = existsSync(join(root, SETTINGS_PATH));
    if (plan.settings.changedKeys.length > 0 || !settingsExists) {
      writeIfChanged(root, SETTINGS_PATH, `${JSON.stringify(plan.settings.merged, null, 2)}\n`);
    }
    for (const path of plan.remove) rmSync(join(root, path), { force: true });
    writeIfChanged(root, VERSION_PATH, `${JSON.stringify(plan.kitVersion, null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Stop || e instanceof Error) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
