// 配布物（harness/managed.json の managed から exclude を除いたもの）と projectOwned の雛形だけを一時ディレクトリに写す
// （managed-smoke・managed-review-source が共有する。#652・#1022）
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isManaged } from '../../lib/sync.ts';

export interface ManagedList {
  managed: string[];
  exclude?: string[];
  projectOwned: { path: string; template: string }[];
}

/** root の harness/managed.json を読む */
export function readManaged(root: string): ManagedList {
  return JSON.parse(readFileSync(join(root, 'harness/managed.json'), 'utf8')) as ManagedList;
}

/**
 * root の git ls-files のうち配布物を、mkdtemp で作った一時ディレクトリ（名前の頭は prefix）に同じパスで写し、
 * projectOwned の雛形を path に写して git init する。作業ツリーに無いファイル・雛形は飛ばす。片付けは呼び出し側が行う
 */
export function copyDistribution(root: string, prefix: string): { dir: string; copied: string[] } {
  const m = readManaged(root);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const copy = (from: string, to: string): void => {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    copyFileSync(join(root, from), join(dir, to));
  };
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const copied = files.filter((f) => isManaged(m.managed, m.exclude ?? [], f) && existsSync(join(root, f)));
  for (const f of copied) copy(f, f);
  for (const o of m.projectOwned) if (existsSync(join(root, o.template))) copy(o.template, o.path);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return { dir, copied };
}
