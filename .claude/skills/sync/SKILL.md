---
name: sync
description: 人が付き添うセッションで、判定済みの PR に main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる（変わっていれば判定し直す）。「PR #番号 に main を取り込んで」「衝突を直して」と頼まれたときに使う。
---

# sync（main の取り込み）

Routine の resolve-conflict（[.claude/routine.md](../../routine.md)）に、判定の引き継ぎの確認を足した手順。対象は `claude/` ブランチの Agent PR。

## 入力

- PR 番号と PR のブランチ
- 前回の判定の head：`node harness/scripts/agent.ts judge-input <PR番号>` のファイルの「前回の判定」の `headSha`（無ければ判定前の PR。取り込んだ後に judge をする）

## 手順

1. `node harness/scripts/agent.ts claim <PR番号> --manual` で着手を宣言する。
2. `node harness/scripts/agent.ts worktree <PR のブランチ>` で worktree を作り（出力がパス）、そこで作業する。
3. `git fetch origin` のあと、前回の判定の head での PR 自身の差分の patch-id を控える：`git diff origin/main...<前回の判定の head> | git patch-id --verbatim`
4. `git merge origin/main` で main を取り込み、衝突を解消する。両方の変更の意図を残す（main 側の変更を消さない）。判断できない衝突は解消せず、人に返す。
5. `npm run check` を通す。
6. `git add <ファイル>` でファイルを指定して merge を commit し、`git push` する（force push しない）。
7. 取り込み後の patch-id を同じ方法で取る：`git diff origin/main...HEAD | git patch-id --verbatim`（`origin/main` は手順3で取ってきたもの）。
8. 手順3と比べる。
   - **同じ**：判定は作り直さない。App が前回の判定を引き継いだことを `gh pr view <PR番号> --json isDraft,statusCheckRollup` で確かめる（新しい head で `agent/review`・`agent/risk` が成功し、`isDraft` が false）。数分待っても引き継がれなければ judge（再レビュー）をやる。
   - **違う**：judge（再レビュー）をやる。
9. 何をどう解消したかを PR にコメントし（先頭に `<!-- agent-harness:claude -->`）、`node harness/scripts/agent.ts release <PR番号>` で着手を解除する。

**前回の判定コメントの `headSha` を新しい head に書き換えて投稿することは禁止。** 判定していない head を判定したことになる。判定を出し直すのは、引き継ぎの確認か judge のどちらかだけ。

## 終わりの状態

- main を取り込んだコミットが PR のブランチに push され、衝突が無い。
- 新しい head で判定が有効（App が引き継いだか、judge で出し直して App が受け付けた）。

## 人に返す条件

- 両方の意図を残して解消できない衝突がある
- 取り込み後に `npm run check` が落ち、この PR の範囲で直せない
- patch-id が同じなのに App が判定を引き継がず、judge でも受け付けられない
- やってはいけないこと：古い判定の head の書き換え、force push、rebase、Merge、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped` と `*:exempt` のラベルの付け外し
