---
name: arch-review
description: 人が付き添うセッションで、Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれ（重複・置き場所・docs との食い違い・コードの書き方）を見つけて、直す Issue の下書きを人に示す。「設計を見直して」「最近の変更をまとめて見て」と頼まれたときに使う。
---

# arch-review（Merge 済みの変更をまとめて見直す）

PR ごとの判定（reviewer・risk-agent・review-panel）は1つの PR の diff しか見ないので、Issue をまたいで積み重なったずれ（同じ役割の関数の重複、置き場所の崩れ、docs と実装の食い違い）は拾えない。この skill は人が呼んだときだけ動き、Merge 済みの PR をまとめて読んで、直す Issue の下書きを人に示す。直すかどうか・どれを Issue にするかは人が決める。結果は PR ごとの判定の材料にしない。

決まる部分（前回見た位置の読み書き・対象の PR の割り出し・下書きの書式検査）は `harness/lib/arch-review.ts` にあり、下の手順のコマンドから使う。記録の書式は [docs/formats.md](../../../docs/formats.md) の「arch-review の記録」。

## 入力

- 対象の範囲：既定は前回の arch-review の記録（ダッシュボード Issue へのコメント）の `headSha` から既定ブランチの先頭まで。前回の記録が無ければ、既定ブランチ宛ての Merge 済みの PR の新しい順に直近 10 本。
  - `--since <sha>`：前回の記録の代わりにその SHA から見る（40桁）
  - `--until <sha>`：既定ブランチの先頭の代わりにその SHA まで見る（40桁）
  - `--last <n>`：前回の記録があっても、Merge 済みの直近 n 本を見る
- 人が観点を絞ったときは、その観点だけ（既定は下の4つ全部）

## 観点

arch-reviewer（[.claude/agents/arch-reviewer.md](../../agents/arch-reviewer.md)）に、1回に1つずつ渡す。

1. **重複**：同じ役割の関数・型・書式（コメントのブロック・目印・コマンドの引数の読み方など）が、別の PR で別の場所に作られている。
2. **置き場所**：`harness/lib/`（ロジック）・`harness/gates/`（App として動くゲート）・`harness/scripts/`（コマンド）の分け方（CLAUDE.md の構成の表と各 README）から外れた置き場所。
3. **docs との食い違い**：docs（`docs/operations.md`・`docs/formats.md`・`docs/glossary.md`）と skill・実装の書いていることが違う。
4. **コードの書き方**：CLAUDE.md の「コードの書き方」の規則（型注釈を剥がすだけで消えない構文、相対 import の拡張子、依存の追加、テストの置き場所、README の表など）が守られていない。

## 手順

作業の置き場所 `<dir>` は scratchpad の `arch-review-<head7>/`（`head7` は見る SHA の先頭7文字）。Issue の作業ではないので着手宣言は要らない。

1. `node harness/scripts/agent.ts arch-review-range` で範囲を読む（入力のオプションはそのまま渡す）。出力の `prs`（PR 番号・タイトル・マージコミットの SHA）・`headSha`・`truncated`・`note` を控える。`prs` が空なら「見る PR がありません」と人に伝えて終える（記録は残さない）。`truncated` が真なら、範囲の全部を読めていないことを人に伝え、`--since` で狭めるかを聞く。
2. `node harness/scripts/agent.ts worktree <headSha> --detach` で、見る main をその SHA に固定した worktree を作る（出力がパス）。担当にはこのパスで読ませる。
3. 観点1〜4ごとに **arch-reviewer** を並行して呼ぶ。渡すのは、観点の番号、worktree のパスと見る SHA、PR ごとの番号とマージコミットの SHA、出力のパス `<dir>/lens<観点の番号>.json` だけ。PR の説明は渡さない。判定コメント（`agent-verdict`・review-panel の記録）も渡さない。担当が書いたファイルが JSON として読めるかを確かめ、無ければ同じパスで1回だけ呼び直す。
4. 指摘をまとめる。同じ根拠を指す指摘は1つにし、直す単位（1つの Issue で閉じる大きさ）に分ける。直す価値が低いもの（好みの違い、既に開いた Issue で直る予定のもの）は下書きにせず、要約にだけ残す。
5. 開いた Issue に同じものが無いかを `gh issue list --state open --search "<キーワード>"` で探す。同じものがあれば新しく立てず、その Issue へのコメントの案にする（下書きの `duplicateOf` にその番号を書く）。
6. 下書きを JSON（`[{ "title": "type(scope): 説明", "body": "…", "duplicateOf": 番号 }]`）にして `<dir>/drafts.json` に書き、`node harness/scripts/agent.ts arch-review-drafts <dir>/drafts.json` で検査する。本文は Issue Form（`.github/ISSUE_TEMPLATE/agent-task.yml`）の見出し（`### Goal`・`### Background`・`### Requirements`・`### Non-goals`・`### Acceptance Criteria`・`### Dependencies`・`### Validation Requirements`）に沿わせ、Background に根拠（パスと行、どの PR で入ったか）を書く。誤りがあれば直して検査し直す。
7. 検査の出力の一覧と、下書きごとの要点（根拠・なぜずれか・直し方の案）を人に示し、どれを作るか（コメントの案はどれを投稿するか）を AskUserQuestion で聞く（1回に4問まで。harness/CLAUDE.harness.md の進め方）。おすすめを先頭の選択肢に置く。
8. 人が選んだものだけを `gh issue create --title "<タイトル>" --body-file <本文のファイル>` で作る。ラベルは指定しない。`agent:ready` は付けない（着手の許可は人が出す）。`priority:*`・`area:*` は Jev に任せる。コメントの案は、人が選んだものだけを `gh issue comment <番号> --body-file <ファイル>` で投稿する（先頭に `<!-- agent-harness:claude -->`）。
9. Issue を作ったら、harness/CLAUDE.harness.md の進め方のとおり、人が「作るだけ」と言わない限り、ship（複数なら fleet）で plan に進めるかを手順7と同じ問いの中で聞いておき、その答えに従う。
10. 見た範囲と要約を記録にする。`{ "version": 1, "baseSha": <手順1の baseSha>, "headSha": <手順1の headSha>, "prs": [PR 番号], "summary": ["見つけたずれ（1件1行）"], "drafts": [{ "title": "…", "created": <作った Issue の番号か null> }] }` を `<dir>/record.json` に書き、`node harness/scripts/agent.ts arch-review-record <dir>/record.json` でダッシュボード Issue にコメントする。`--since`・`--until` で過去の範囲を見たとき（前回の位置を巻き戻すことになるとき）は、`node harness/scripts/agent.ts arch-review-record <dir>/record.json --dry-run` にとどめる。
11. `node harness/scripts/agent.ts worktree-remove <headSha>` で worktree を消す。

## 出力

人に返すもの：

- 見た範囲（`baseSha`〜`headSha`、PR の番号の一覧、`truncated`・`note` があればその内容）
- 下書きの一覧（検査の出力）と、下書きごとの根拠・なぜずれか・直し方の案
- 作った Issue・投稿したコメントの番号と、作らなかった下書き
- 記録のコメントの URL（`--dry-run` のときは本文）

## 終わりの状態

- 人が選んだ下書きだけが Issue（ラベルなし）かコメントになっている。
- ダッシュボード Issue に記録のコメントが1つ増え、次の arch-review がそこから読める（`--dry-run` のときは増えない）。
- 見るために作った worktree が消えている。リポジトリのファイルは変わっていない。

## 人に返す条件

- `arch-review-range` が止まった（ダッシュボードが無いときは `note` を人に伝えて、直近の本数で続ける）、`truncated` が真で範囲の決め方を人が決めていない
- 担当が入力の不足を報告した、出力のパスにファイルを書かなかった（同じパスで呼び直しても無い）、書いたファイルが JSON として読めない
- 下書きが `arch-review-drafts` の検査を通らず、直し方が決まらない
- `arch-review-record` がダッシュボードの無いことで止まった（記録の JSON を人に示す）
- hook（`.claude/hooks/guard.ts`）が操作を止めた、操作が拒否された（別の方法で試さない）
- やってはいけないこと：見つけたずれをその場で直す（直すのは作った Issue の ship で）、PR・判定コメントへの投稿、結果を reviewer・risk-agent・review-panel に渡すこと、人が選んでいない Issue の作成やコメントの投稿、`agent:ready` やほかのラベルの付け外し（`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-merge` と `*:exempt` を含む）、Issue 本文の書き換え、Merge
