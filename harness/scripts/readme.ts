/**
 * README の表（名前・内容・ガードレール）を、各ディレクトリの直下の名前と先頭のコメントから作る。
 * ガードレールの安全の仕組みではない（判定・自動 Merge には関わらない）ので、`harness/lib/` ではなくここに置き、
 * ガードレールの外（`agent.ts` の外）で人が直せるようにする。
 *
 *   node harness/scripts/readme.ts render <ディレクトリ>       表を標準出力に出す
 *   node harness/scripts/readme.ts write [<ディレクトリ>...]   README の表を書き換える（省略で対象すべて）
 *   node harness/scripts/readme.ts check                       表が生成結果と一致するか、名前が実在するかを確かめる
 *
 * 対象は14ディレクトリ（`.github` は README.md を持たず、root の README.md の「`.github/`」節を書き換える）。
 * `harness/test`・`harness/test/support` は説明の生成の対象外（Non-goal）で、名前の実在の検査だけかける。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, MANAGED_PREFIXES } from '../lib/config.ts';
import { guardrailFiles } from '../lib/guardrail.ts';
import { globToRegExp } from '../lib/scope.ts';

export type GuardMark = '' | '○' | '対象外' | '一部';

export interface GuardrailConfig {
  guardrailPaths?: string[];
  guardrailExclude?: string[];
}

export const TARGET_DIRS: string[] = [
  'harness',
  'harness/lib',
  'harness/gates',
  'harness/scripts',
  'harness/templates',
  'harness/test',
  'harness/test/support',
  '.claude',
  '.claude/agents',
  '.claude/skills',
  '.claude/hooks',
  '.github',
  '.github/workflows',
  'docs',
];

export const NO_GENERATE_DIRS: string[] = ['harness/test', 'harness/test/support'];

export const NO_COMMENT_ALLOWLIST: string[] = [
  '.claude/settings.json',
  'harness/templates/claude-settings.deny.json',
  '.github/ISSUE_TEMPLATE/',
  '.github/pull_request_template.md',
];

/** 先頭にコメントを書けない4件の、README にそのまま残す説明（手書き。生成しない） */
const NO_COMMENT_TEXT: Record<string, string> = {
  '.claude/settings.json':
    'Claude Code の設定。させない操作の一覧（`permissions.deny`）と、見張りの hook の登録、チームで使うプラグインの登録（版を固定）と外部のページの許可。',
  'harness/templates/claude-settings.deny.json':
    'Claude Code にさせない操作（Merge、main への push、保護ラベルの付け外し、Secret・資格情報の読み出しなど）の一覧。`.claude/settings.json` の `permissions.deny` と同じ内容で、変えるときは両方を直す',
  '.github/ISSUE_TEMPLATE/':
    'Issue の作り方の設定。`agent-task.yml` は「Agent タスク」の Issue Form（Goal・Requirements・Acceptance Criteria などの見出しをゲートが読む）、`config.yml` は Form を使わない Issue も作れるようにする設定。ここに .md を置くと Issue のテンプレートとして扱われるので、README は置かない',
  '.github/pull_request_template.md': 'PR 本文の見本（`Closes #番号`、変更の概要、AC ごとの対応、範囲外の変更、テスト）',
};

const START_MARK = '<!-- readme:generated start -->';
const END_MARK = '<!-- readme:generated end -->';
const BLOCK_RE = /<!-- readme:generated start -->\n?([\s\S]*?)\n?<!-- readme:generated end -->/;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// ---- ガードレールの列 ----

export function guardrailMarkForFile(config: GuardrailConfig, relPath: string): GuardMark {
  const paths = config.guardrailPaths;
  if (!paths) return '○'; // 一覧が無ければすべてガードレール（安全側。harness/lib/guardrail.ts と同じ）
  if (guardrailFiles(config, [relPath]).length > 0) return '○';
  const included = paths.some((p) => globToRegExp(p).test(relPath));
  return included ? '対象外' : '';
}

export function guardrailMarkForDir(config: GuardrailConfig, relChildFiles: string[]): GuardMark {
  if (relChildFiles.length === 0) return '';
  const marks = relChildFiles.map((f) => guardrailMarkForFile(config, f));
  if (marks.every((m) => m === '○')) return '○';
  if (marks.some((m) => m === '○')) return '一部';
  return '';
}

function safeLoadConfig(root: string): GuardrailConfig {
  try {
    return loadConfig(join(root, 'harness.config.json'));
  } catch {
    return {};
  }
}

// ---- 直下の名前・配下のファイル一覧（git、無ければ fs にフォールバック） ----

function gitListUnder(root: string, relPath: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '-z', '--', relPath], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

function fsListUnder(root: string, relDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk(relDir);
  return out;
}

/** relDir 配下（再帰）の、git 管理下（無ければ fs 上）のファイルの相対パス一覧 */
function filesUnder(root: string, relDir: string): string[] {
  return gitListUnder(root, relDir) ?? fsListUnder(root, relDir);
}

/** relDir 直下の名前（README.md を除く。ディレクトリは「名前/」） */
export function directChildren(root: string, relDir: string): string[] {
  const files = filesUnder(root, relDir);
  const prefix = `${relDir}/`;
  const names = new Set<string>();
  for (const p of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf('/');
    names.add(i === -1 ? rest : `${rest.slice(0, i)}/`);
  }
  names.delete('README.md');
  return [...names].sort();
}

// ---- 先頭のコメントの抽出 ----

function stripStar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('* ')) return t.slice(2);
  if (t === '*') return '';
  if (t.startsWith('*')) return t.slice(1);
  return t;
}

function extractTsComment(content: string): string | null {
  const lines = content.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const t = lines[i]!.trim();
    if (t === '') {
      i++;
      continue;
    }
    if (/^import\b/.test(t)) {
      while (i < n && !lines[i]!.trim().endsWith(';')) i++;
      i++;
      continue;
    }
    break;
  }
  if (i >= n) return null;
  const first = lines[i]!.trim();
  if (!first.startsWith('/**')) return null;

  if (first.endsWith('*/')) {
    const inner = first.slice(3, first.length - 2).trim();
    return inner.length > 0 && !inner.startsWith('@') ? inner : null;
  }

  const body: string[] = [];
  for (i = i + 1; i < n; i++) {
    const t = lines[i]!.trim();
    if (t === '*/') break;
    const stripped = stripStar(t);
    if (stripped.trimStart().startsWith('@')) break;
    body.push(stripped);
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

function stripMdInline(line: string): string {
  return line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '');
}

function parseFrontmatterDescription(content: string): string | undefined {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return undefined;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return undefined;
  const body = content.slice(4, end);
  const m = body.match(/^description:\s*(.*)$/m);
  if (!m) return undefined;
  let value = m[1]!.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function extractMdComment(content: string): string | null {
  const fm = parseFrontmatterDescription(content);
  if (fm !== undefined) return fm.length > 0 ? fm : null;
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (idx === -1) return null;
  const rest = lines.slice(idx + 1);
  let start = 0;
  while (start < rest.length && rest[start]!.trim() === '') start++;
  if (start >= rest.length) return null;
  const body = rest
    .slice(start)
    .map(stripMdInline)
    .join('\n');
  return body.trim().length > 0 ? body : null;
}

function extractYmlComment(content: string): string | null {
  const lines = content.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    out.push(stripStar(line.replace(/^#/, '*')));
  }
  return out.length > 0 ? out.join('\n') : null;
}

/** relPath は拡張子の判定にだけ使う。種類ごとの決まりは docs/plan.md の Q89（Issue #132） */
export function extractComment(relPath: string, content: string): string | null {
  const ext = extname(relPath);
  if (ext === '.ts') return extractTsComment(content);
  if (ext === '.md') return extractMdComment(content);
  if (ext === '.yml' || ext === '.yaml') return extractYmlComment(content);
  return null;
}

/** ディレクトリの先頭のコメント：README.md（無ければ SKILL.md）の先頭のコメント */
export function extractDirComment(root: string, relDir: string): string | null {
  const segments = relDir.split('/');
  const readmePath = join(root, ...segments, 'README.md');
  if (existsSync(readmePath)) {
    return extractComment(`${relDir}/README.md`, readFileSync(readmePath, 'utf8'));
  }
  const skillPath = join(root, ...segments, 'SKILL.md');
  if (existsSync(skillPath)) {
    return extractComment(`${relDir}/SKILL.md`, readFileSync(skillPath, 'utf8'));
  }
  return null;
}

// ---- 1文目の切り方 ----

const isAscii = (c: string): boolean => c.length > 0 && c.charCodeAt(0) <= 0x7f;

export function firstSentence(paragraph: string): string {
  const lines = paragraph.split('\n');
  const collected: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') break;
    if (/^\s*([-*]\s|\d+\.\s)/.test(line)) break;
    collected.push(line.trim());
  }
  if (collected.length === 0) return '';
  let joined = collected[0]!;
  for (let k = 1; k < collected.length; k++) {
    const prevChar = joined.slice(-1);
    const nextChar = collected[k]!.charAt(0);
    joined += isAscii(prevChar) && isAscii(nextChar) ? ` ${collected[k]}` : collected[k];
  }
  const idx = joined.indexOf('。');
  return idx === -1 ? joined : joined.slice(0, idx + 1);
}

// ---- 表セルの扱い ----

export function toCell(text: string): string {
  const escaped = text.replace(/\|/g, '\\|');
  // ```word（と、そのあとに ``` が続けば一緒に）を ````word```` に置き換える。閉じが無い（フェンスの体を成さない）
  // 参照でも必ず閉じを付け、開いたままの ``` が残ってセルの区切り | を巻き込まないようにする
  return escaped.replace(/```([\w-]+)(?:```)?/g, '````$1````');
}

// ---- 表の生成・書き込み ----

export function readmeFileFor(root: string, relDir: string): string {
  if (relDir === '.github') return join(root, 'README.md');
  return join(root, ...relDir.split('/'), 'README.md');
}

function contentCellFor(root: string, relDir: string, name: string): string {
  const isDir = name.endsWith('/');
  const bare = isDir ? name.slice(0, -1) : name;
  const relPath = `${relDir}/${bare}`;
  const key = isDir ? `${relPath}/` : relPath;
  const override = NO_COMMENT_TEXT[key];
  if (override !== undefined) return toCell(override);

  const raw = isDir ? extractDirComment(root, relPath) : extractFileComment(root, relPath);
  if (raw === null) return '';
  return toCell(firstSentence(raw));
}

function extractFileComment(root: string, relPath: string): string | null {
  const abs = join(root, ...relPath.split('/'));
  if (!existsSync(abs)) return null;
  return extractComment(relPath, readFileSync(abs, 'utf8'));
}

function guardCellFor(config: GuardrailConfig, relDir: string, name: string, root: string): GuardMark {
  const isDir = name.endsWith('/');
  const bare = isDir ? name.slice(0, -1) : name;
  const relPath = `${relDir}/${bare}`;
  if (!isDir) return guardrailMarkForFile(config, relPath);
  return guardrailMarkForDir(config, filesUnder(root, relPath));
}

export function renderTable(root: string, relDir: string): string {
  const config = safeLoadConfig(root);
  const children = directChildren(root, relDir);
  const rows = children.map((name) => {
    const content = contentCellFor(root, relDir, name);
    const guard = guardCellFor(config, relDir, name, root);
    return `| \`${name}\` | ${content} | ${guard} |`;
  });
  return ['| 名前 | 内容 | ガードレール |', '| --- | --- | --- |', ...rows].join('\n');
}

export function currentBlock(root: string, relDir: string): string | null {
  const path = readmeFileFor(root, relDir);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  const m = content.match(BLOCK_RE);
  return m ? m[1]! : null;
}

export function writeReadme(root: string, relDir: string): void {
  const path = readmeFileFor(root, relDir);
  const content = readFileSync(path, 'utf8');
  const table = renderTable(root, relDir);
  if (!BLOCK_RE.test(content)) {
    throw new Error(`${path} に readme:generated のマーカーが無い`);
  }
  const next = content.replace(BLOCK_RE, `${START_MARK}\n${table}\n${END_MARK}`);
  writeFileSync(path, next);
}

// ---- README の表の名前の実在（AC1） ----

/** 生成の目印（<!-- readme:generated start/end -->）の中だけを見る（無ければ全文。`.github` は root README の節がここで絞られる） */
export function namesInTable(text: string): string[] {
  const m = text.match(BLOCK_RE);
  const scope = m ? m[1]! : text;
  const names: string[] = [];
  for (const line of scope.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|');
    const first = cells[1];
    if (first === undefined) continue;
    const matches = first.match(/`([^`]+)`/g);
    if (!matches) continue;
    for (const m of matches) names.push(m.slice(1, -1));
  }
  return names;
}

export function staleNames(names: string[], children: string[]): string[] {
  const missing: string[] = [];
  for (const name of names) {
    if (name.includes('*')) {
      const re = globToRegExp(name);
      const hit = children.some((c) => re.test(c) || re.test(c.replace(/\/$/, '')));
      if (!hit) missing.push(name);
      continue;
    }
    if (!children.includes(name)) missing.push(name);
  }
  return missing;
}

// ---- overview.html のラベル（AC3） ----

export function labelsInOverview(html: string): string[] {
  const labels = new Set<string>();
  const codeRe = /<code>([^<]*)<\/code>/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(html)) !== null) {
    const text = m[1]!.trim();
    if (text === 'epic') labels.add(text);
    else if (MANAGED_PREFIXES.some((p) => text.startsWith(p))) labels.add(text);
  }
  return [...labels];
}

export interface LabelMismatch {
  unknownOnPage: string[];
  missingFromSection: string[];
}

function labelsSection(html: string): string {
  const idx = html.indexOf('id="labels"');
  return idx === -1 ? '' : html.slice(idx);
}

function coveredBy(defs: { name: string }[], label: string): boolean {
  if (label.endsWith(':*')) {
    const prefix = label.slice(0, -1);
    return defs.some((d) => d.name.startsWith(prefix));
  }
  return defs.some((d) => d.name === label);
}

export function checkOverviewLabels(html: string, defs: { name: string }[]): LabelMismatch {
  const pageLabels = labelsInOverview(html);
  const unknownOnPage = pageLabels.filter((l) => !coveredBy(defs, l));

  const section = labelsSection(html);
  const sectionLabels = new Set(labelsInOverview(section));
  const missingFromSection: string[] = [];
  for (const def of defs) {
    const covered = sectionLabels.has(def.name) || [...sectionLabels].some((l) => l.endsWith(':*') && def.name.startsWith(l.slice(0, -1)));
    if (!covered) missingFromSection.push(def.name);
  }
  return { unknownOnPage, missingFromSection };
}

// ---- 全体の検査（check） ----

export interface CheckResult {
  mismatches: string[];
  staleNames: string[];
  noCommentIssues: string[];
}

function computeNoCommentIssues(root: string): string[] {
  const issues: string[] = [];
  const allowlist = new Set(NO_COMMENT_ALLOWLIST);
  const seen = new Set<string>();
  for (const dir of TARGET_DIRS) {
    if (NO_GENERATE_DIRS.includes(dir)) continue;
    for (const name of directChildren(root, dir)) {
      const isDir = name.endsWith('/');
      const bare = isDir ? name.slice(0, -1) : name;
      const relPath = `${dir}/${bare}`;
      const key = isDir ? `${relPath}/` : relPath;
      const raw = isDir ? extractDirComment(root, relPath) : extractFileComment(root, relPath);
      const hasComment = raw !== null;
      if (allowlist.has(key)) {
        seen.add(key);
        if (hasComment) issues.push(`${key}: 一覧にあるが先頭のコメントがある`);
      } else if (!hasComment) {
        issues.push(`${key}: 先頭のコメントが無く、一覧にも無い`);
      }
    }
  }
  for (const key of NO_COMMENT_ALLOWLIST) {
    if (!seen.has(key)) issues.push(`${key}: 一覧にあるが実在しない`);
  }
  return issues;
}

export function checkAll(root: string): CheckResult {
  const mismatches: string[] = [];
  for (const dir of TARGET_DIRS) {
    if (NO_GENERATE_DIRS.includes(dir)) continue;
    const expected = renderTable(root, dir);
    const actual = currentBlock(root, dir);
    if (actual !== expected) mismatches.push(dir);
  }
  const staleList: string[] = [];
  for (const dir of TARGET_DIRS) {
    const path = readmeFileFor(root, dir);
    if (!existsSync(path)) continue;
    const names = namesInTable(readFileSync(path, 'utf8'));
    const children = directChildren(root, dir);
    const missing = staleNames(names, children);
    if (missing.length > 0) staleList.push(`${dir}: ${missing.join(', ')}`);
  }
  const noCommentIssues = computeNoCommentIssues(root);
  return { mismatches, staleNames: staleList, noCommentIssues };
}

// ---- CLI（import.meta.main の中だけで動く） ----

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'render') {
    const dir = args[0];
    if (!dir) throw new Error('ディレクトリを指定してください');
    console.log(renderTable(ROOT, dir));
  } else if (cmd === 'write') {
    const dirs = args.length > 0 ? args : TARGET_DIRS.filter((d) => !NO_GENERATE_DIRS.includes(d));
    for (const dir of dirs) {
      writeReadme(ROOT, dir);
      console.log(`書き換えた: ${dir}`);
    }
  } else if (cmd === 'check') {
    const result = checkAll(ROOT);
    let ok = true;
    if (result.mismatches.length > 0) {
      ok = false;
      console.log('生成結果と食い違う README:');
      for (const d of result.mismatches) console.log(`  - ${d}`);
    }
    if (result.staleNames.length > 0) {
      ok = false;
      console.log('実在しない名前:');
      for (const s of result.staleNames) console.log(`  - ${s}`);
    }
    if (result.noCommentIssues.length > 0) {
      ok = false;
      console.log('先頭のコメントの一覧との食い違い:');
      for (const s of result.noCommentIssues) console.log(`  - ${s}`);
    }
    if (ok) console.log('OK');
    process.exit(ok ? 0 : 1);
  } else {
    console.error('使い方: node harness/scripts/readme.ts render|write|check ...');
    process.exit(1);
  }
}
