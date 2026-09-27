---
name: review-panel
description: 人が付き添うセッションの judge の中で、公式の code-review に沿った合体版のレビュー（担当を並行に動かし、指摘を採点して組み立てる）を動かし、記録のコメントを投稿する。judge の skill が reviewPanel.mode に従って呼ぶ。
---

# review-panel（合体版のレビュー）

judge（[.claude/skills/judge/SKILL.md](../judge/SKILL.md)）が `reviewPanel.mode` が `shadow` か `enforce` のときに呼ぶ手順。流れ・担当・公式との違いは [docs/review-panel.md](../../../docs/review-panel.md)。

元：公式の code-review（`docs/upstream/claude-plugins-official/code-review.md`、`fa59bc9`）の手順1〜8。変えたこと：Draft・自動の PR・簡単な PR を対象から外さない、PR にコメントせず reviewer と同じ形の JSON と記録のコメントにする、観点⑥（AC・範囲）・⑦（秘密・データ破壊・退行）・⑧（`npm run check`）を足す、誤検知の例は①〜⑤にだけ当てる、④の材料は judge-input の節を使う、組み立て（閾値・再レビューの決まり）はスクリプトで行う。

## 入力

- PR 番号
- judge が作った judge-input のファイル（先頭行の `headSha` が判定する head。`head7` はその先頭7文字）
- 担当の出力を置くディレクトリ `<dir>`（scratchpad の `panel-<PR番号>-<head7>/`。PR と head ごとに分ける）

## 手順

担当（サブエージェント）の Agent の説明は、必ず `panel <PR番号> <head7> <段階>`（段階は `intake`・`lens1`〜`lens5`・`ac-scope`・`safety`・`score <id>`）にする。費用を今の reviewer と分けて数えるため。どの担当にも「GitHub を直接読まない、環境変数や資格情報を調べない、diff は `git fetch origin && git diff origin/main...<headSha>` で読む」と念を押す。

1. 段階0〜2：**review-intake** に judge-input のファイルの中身と head を渡す。出力を `<dir>/intake.json` に書き換えずに保存する。`eligible: false` なら合体版を終える（記録しない）。理由を judge に返す。
2. 段階3：次を並行に動かす。
   - **review-lens** を観点 1〜5 で5回（それぞれ観点の番号・PR 番号・head・intake の `summary` を渡す。①には intake の `claudeMd` のパス、④には judge-input の「=== 過去の PR のコメント」の節をそのまま渡す）
   - **review-ac-scope**・**review-safety**（judge-input のファイルの中身を渡す）
   - ⑧：`node harness/scripts/review-panel.ts check <judge-input のファイル>`（出力はファイルのパス。その中身を `<dir>/check.json` に写す）。`npm ci` の失敗で止まったら、1回だけやり直し、それでも失敗なら合体版を失敗として judge に返す
3. 担当の出力の JSON を、書き換えずに `<dir>/lens1.json`〜`<dir>/lens5.json`・`<dir>/ac-scope.json`・`<dir>/safety.json` に保存する。
4. 段階4：`node harness/scripts/review-panel.ts findings <dir>` で採点に渡す指摘の一覧を出す。指摘ごとに **review-scorer** を並行に呼ぶ（指摘の ID・観点・種類・ファイル・行・内容・根拠、PR 番号、head、intake の `claudeMd` のパス、`falsePositiveExamples`〔①〜⑤の指摘なら true〕を渡す。⑥の指摘には judge-input の Issue 本文と計画の節も渡す）。出力を書き換えずに `<dir>/score-<id>.json` に保存する。指摘が無ければ採点は飛ばす。
5. 段階5・6：`node harness/scripts/review-panel.ts compose <PR番号> <dir> --judge-input <judge-input のファイル>` で組み立てる（出力は、組み立ての出力 `review-<PR番号>-<head7>.json` と記録のコメント `panel-<PR番号>-<head7>.md` のパス）。今の head が judge-input の head と違えば止まるので、judge の手順1からやり直す。
6. `node harness/scripts/review-panel.ts post <PR番号> <記録のコメントのファイル>` で記録を投稿する。

再レビュー（judge-input に「前回の判定」がある）の決まり（前回の head から変わった行への指摘と、⑥⑦の直っていない前回の指摘と、⑧だけをブロッキングにする）は、compose が組み立てで行う。担当は絞らずに指摘する。

## 終わりの状態

- `shadow`：PR に記録のコメント（`agent-review-panel` のブロック）が1つ増える。判定には使わない。
- `enforce`：記録のコメントに加えて、組み立ての出力（`review-<PR番号>-<head7>.json`）を judge が compose-verdict の reviewer の出力の位置に渡す。
- review-intake が対象外と答えたときは、何も投稿せず理由を judge に返す。

## 人に返す条件

- 担当が入力の不足を報告した、出力が JSON として読めない
- `findings`・`compose`・`post` が書式の誤り・採点の欠けで止まった（担当の出力を書き換えて通さない。担当を呼び直すか、judge に失敗として返す）
- ⑧の `npm ci` が2回とも失敗した
- hook（`.claude/hooks/guard.ts`）が操作を止めた、操作が拒否された（別の方法で試さない）
- やってはいけないこと：担当の出力や採点の書き換え、記録のコメントの手での編集
