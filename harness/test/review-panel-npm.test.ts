// Issue #256・#640：review-panel.ts check のコマンドの起動（projectCommand を使う）と、取り込みのコマンド（既定 npm ci）が失敗したときのメッセージ（起動できなかった理由・終了コード・出力の末尾）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installFailureMessage } from '../lib/review-panel.ts';

const HEAD = 'npm ci が失敗しました（⑧の指摘にはしません。やり直すか人に返す）:';

test('installFailureMessage：起動できなかった（error あり）ときは理由を入れる。先頭の文は渡したコマンドの名前になる', () => {
  const r = { status: null, error: new Error('spawnSync npm ENOENT'), stdout: null, stderr: null };
  const msg = installFailureMessage('npm ci', r);
  assert.equal(msg.split('\n')[0], HEAD);
  assert.ok(msg.includes('起動できませんでした: spawnSync npm ENOENT'), msg);
  const other = installFailureMessage('pip install -e .', r);
  assert.equal(other.split('\n')[0], 'pip install -e . が失敗しました（⑧の指摘にはしません。やり直すか人に返す）:');
});

test('installFailureMessage：0 以外で終わったときは終了コードと出力の末尾20行を入れる（Windows で shell を通して npm が見つからず cmd が「認識されていません」を出して終わる形も同じ）', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
  const stdout = `${lines.slice(0, 15).join('\n')}\n`;
  const stderr = `${lines.slice(15).join('\n')}\n`;
  const msg = installFailureMessage('npm ci', { status: 1, stdout, stderr });
  assert.equal(msg.split('\n')[0], HEAD);
  assert.ok(msg.includes('終了コード 1'), msg);
  for (let i = 6; i <= 25; i++) assert.ok(msg.includes(`line-${i}\n`) || msg.endsWith(`line-${i}`), `line-${i} が無い:\n${msg}`);
  for (let i = 1; i <= 5; i++) assert.ok(!msg.split('\n').includes(`line-${i}`), `line-${i} が入っている:\n${msg}`);
  assert.ok(!msg.includes('起動できませんでした'), msg);
});

test('installFailureMessage：Windows で npm が認識されないときの cmd の出力が入る', () => {
  const stderr = "'npm' は、内部コマンドまたは外部コマンド、\n操作可能なプログラムまたはバッチ ファイルとして認識されていません。\n";
  const msg = installFailureMessage('npm ci', { status: 1, stdout: '', stderr });
  assert.equal(msg.split('\n')[0], HEAD);
  assert.ok(msg.includes('終了コード 1'), msg);
  assert.ok(msg.includes('認識されていません'), msg);
});

test('installFailureMessage：status が null（シグナルで終了）のときはそう書く', () => {
  const msg = installFailureMessage('npm ci', { status: null, stdout: 'partial\n', stderr: '' });
  assert.equal(msg.split('\n')[0], HEAD);
  assert.ok(msg.includes('(シグナルで終了)'), msg);
  assert.ok(msg.includes('partial'), msg);
});

test('harness/scripts/review-panel.ts は npm を直接 spawnSync せず projectCommand で起動する', () => {
  const src = readFileSync(fileURLToPath(new URL('../scripts/review-panel.ts', import.meta.url)), 'utf8');
  assert.ok(!src.includes("spawnSync('npm'"), "spawnSync('npm' が残っている");
  assert.ok(src.includes('projectCommand('), 'projectCommand( を使っていない');
});
