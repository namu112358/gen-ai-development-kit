/**
 * 段階のファイル：agent.ts step（harness/lib/step.ts）が返した今の段階（Issue・ノード・ブランチ・計画の files）を、セッションごとに書くファイル（Issue #306）。
 * 置き場所は git の共通ディレクトリ（`git rev-parse --path-format=absolute --git-common-dir`）の下の `agent-harness/stage/<セッションの ID>.json`。
 * worktree からも同じ場所で、commit されない。段階に合わない操作を止める hook（別 Issue）がこれを読む。
 * 批評の回（plan ⇄ plan-critique の回と必須の指摘）も、同じ Issue・同じ計画ゲートの記録の間だけここに残す。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TRANSCRIPT_SESSION_ID } from './session.ts';

/** 批評の1回（plan-critic の判定と、必須の指摘の文） */
export interface CritiqueRound {
  verdict: 'go' | 'revise' | 'split' | 'drop';
  must: string[];
}

/** 批評の回の持ち越し。同じ Issue で、計画ゲートの記録の時刻（無ければ null）が同じ間だけ引き継ぐ */
export interface CritiqueState {
  issue: number;
  gateAt: string | null;
  rounds: CritiqueRound[];
}

export interface StageFile {
  version: 1;
  session: string;
  /** 書いた時刻（ISO 8601） */
  at: string;
  issue: number;
  pr: number | null;
  /** step が返したノード（flow.ts のノード ID） */
  node: string;
  /** step の結果の種類 */
  kind: 'node' | 'wait' | 'stop';
  /** 作業するブランチ（PR があればその head。無ければ null） */
  branch: string | null;
  /** この Issue のブランチの接頭辞（claude/issue-<番号>-） */
  branchPrefix: string;
  /** 計画ゲートの記録の計画の files（計画の前は null） */
  files: string[] | null;
  critique: CritiqueState | null;
}

/** 段階のファイルのパス。ID が記録のファイル名に使える形（TRANSCRIPT_SESSION_ID）でなければ null（書かない） */
export function stageFilePath(gitCommonDir: string, session: string | null): string | null {
  if (!session || !TRANSCRIPT_SESSION_ID.test(session)) return null;
  return join(gitCommonDir, 'agent-harness', 'stage', `${session}.json`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const VERDICTS = ['go', 'revise', 'split', 'drop'];

/** 段階のファイルの書式の誤り（無ければ空） */
export function checkStageFile(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['段階のファイルはオブジェクト'];
  if (value.version !== 1) errors.push('version は 1');
  if (typeof value.session !== 'string' || !TRANSCRIPT_SESSION_ID.test(value.session)) errors.push('session は英数字と - _ だけの文字列');
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) errors.push('at は日時の文字列');
  if (!isPositiveInt(value.issue)) errors.push('issue は正の整数');
  if (value.pr !== null && !isPositiveInt(value.pr)) errors.push('pr は正の整数か null');
  if (typeof value.node !== 'string' || value.node === '') errors.push('node は空でない文字列');
  if (!['node', 'wait', 'stop'].includes(value.kind as string)) errors.push('kind は node・wait・stop のどれか');
  if (value.branch !== null && typeof value.branch !== 'string') errors.push('branch は文字列か null');
  if (typeof value.branchPrefix !== 'string') errors.push('branchPrefix は文字列');
  if (value.files !== null && !isStrings(value.files)) errors.push('files は文字列の配列か null');
  const c = value.critique;
  if (c !== null) {
    if (!isObject(c) || !isPositiveInt(c.issue) || (c.gateAt !== null && typeof c.gateAt !== 'string') || !Array.isArray(c.rounds)) errors.push('critique は { issue, gateAt, rounds } か null');
    else if (!c.rounds.every((r) => isObject(r) && VERDICTS.includes(r.verdict as string) && isStrings(r.must))) errors.push('critique.rounds は { verdict, must } の配列');
  }
  return errors;
}

/** 段階のファイルを読む。無い・JSON として読めない・書式が違えば null */
export function readStageFile(path: string): StageFile | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  return checkStageFile(value).length === 0 ? (value as StageFile) : null;
}

/** 段階のファイルを検査して書く（ディレクトリが無ければ作る。途中で読まれても壊れた中身が見えないよう、一時ファイルから置き換える） */
export function writeStageFile(path: string, value: StageFile): void {
  const errors = checkStageFile(value);
  if (errors.length > 0) throw new Error(`段階のファイルの書式の誤り: ${errors.join('、')}`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 前回の段階のファイルから引き継ぐ批評の回。Issue が変わるか、計画ゲートの記録の時刻が変われば空 */
export function carriedCritique(prev: StageFile | null, issue: number, gateAt: string | null): CritiqueRound[] {
  const c = prev?.critique;
  if (!c || c.issue !== issue || c.gateAt !== gateAt) return [];
  return c.rounds.map((r) => ({ verdict: r.verdict, must: [...r.must] }));
}
