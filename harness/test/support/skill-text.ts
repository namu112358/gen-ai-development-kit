// skill の文を確かめるテストが共有する補助（Issue #487）。frontmatter・節・手順の切り出しと、skill ごとの構造の表
// （見出し・本文の語・節や手順の中の語・含まないはずの語・順番）を本文と照らし、足りないものを全部一度に返す skillProblems。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** リポジトリの根 */
export const ROOT = join(import.meta.dirname, '..', '..', '..');

/** 根からの相対パスで読み、CRLF を LF にする */
export const readText = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

/** 先頭の `---` で囲まれた frontmatter を key: value で読む */
export function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split(/\r?\n/).map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す。無ければ空文字 */
export function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 行頭が `<n>. ` の項から、行頭が次の番号付きの行か見出しの行の前までを切り出す（字下げした入れ子の行を含む）。無ければ空文字 */
export function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 表の1行。section だけなら節、step だけなら本文の手順、両方なら節の中の手順、どちらも無ければ本文全体を見る */
export type SkillPart = { section?: string; step?: number; words?: string[]; absent?: string[]; order?: string[] };

/** skill ごとの構造の表 */
export type SkillSpec = { path: string; headings?: string[]; words?: string[]; parts?: SkillPart[] };

/** 表を本文と照らし、足りないもの（無い見出し・節・手順・語、あってはいけない語、順番の違い）を1行ずつ返す。全部そろえば空 */
export function skillProblems(spec: SkillSpec): string[] {
  if (!existsSync(join(ROOT, spec.path))) return [`${spec.path} がありません`];
  const text = readText(spec.path);
  const problems: string[] = [];
  const lines = text.split('\n');
  for (const h of spec.headings ?? []) if (!lines.includes(h)) problems.push(`見出し「${h}」がありません`);
  for (const w of spec.words ?? []) if (!text.includes(w)) problems.push(`本文に「${w}」がありません`);
  for (const part of spec.parts ?? []) {
    let body = text;
    let where = '本文';
    if (part.section !== undefined) {
      body = section(body, part.section);
      where = `節「${part.section}」`;
      if (body === '') {
        problems.push(`${where}がありません`);
        continue;
      }
    }
    if (part.step !== undefined) {
      body = step(body, part.step);
      where = `${part.section !== undefined ? `${where}の` : ''}手順${part.step}`;
      if (body === '') {
        problems.push(`${where}がありません`);
        continue;
      }
    }
    for (const w of part.words ?? []) if (!body.includes(w)) problems.push(`${where}に「${w}」がありません`);
    for (const w of part.absent ?? []) if (body.includes(w)) problems.push(`${where}に「${w}」があってはいけません`);
    const order = part.order ?? [];
    const at = order.map((w) => body.indexOf(w));
    order.forEach((w, k) => {
      if (at[k]! < 0) problems.push(`${where}に「${w}」がありません（順番）`);
    });
    for (let k = 1; k < order.length; k++) {
      if (at[k - 1]! >= 0 && at[k]! >= 0 && at[k - 1]! >= at[k]!) problems.push(`${where}で「${order[k - 1]}」が「${order[k]}」より前にありません`);
    }
  }
  return problems;
}
