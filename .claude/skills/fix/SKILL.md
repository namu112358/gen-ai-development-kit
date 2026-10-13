---
name: fix
description: "人が付き添うセッションで、Agent PR のブロッキング指摘（App の変更要求レビュー）や人のレビューを直して push し、判定をやり直す。「PR #番号 の指摘を直して」と頼まれたとき、判定の後の段階で使う。"
---

# fix（修正）

Routine の fix（[.claude/routine.md](../../routine.md)）を、付き添いのセッションで行う手順。対象は `claude/` ブランチの Agent PR だけ（人の PR は直さない）。

## 入力

- PR 番号
- 直す指摘：App の最新の変更要求レビュー（本文に `kind=fix-request`、作成者が App）のブロッキング指摘と、現在の head へのコラボレーターのレビュー（Claude・App 以外、Comment か Request changes）。`node harness/scripts/agent.ts rest pr-view <PR番号>` の `comments`・`reviews` で読む（`reviews` の `commit.oid` で現在の head へのレビューを見分ける）
- 計画の `files`（`node harness/scripts/agent.ts show-plan <Issue番号>`）

## 手順

1. `node harness/scripts/agent.ts claim <PR番号> --manual --stage fix` で着手を宣言する（`worktree` は PR の宣言を確かめる）。PR が Merge 済み・Closed なら `claim` は宣言せずに止まる。そのときは worktree を作らず push せずに終え、人がすることの一覧に「PR #N は Merge 済み（Closed）のため fix をしなかった」と書く。
2. `node harness/scripts/agent.ts worktree <PR のブランチ>` で worktree を作り（出力がパス）、そこで作業する。
3. 指摘を直す。計画の `files` の範囲で直す。
   - 計画の `files` の外の変更が要ると分かったら、書きかけの変更は commit・push しない。
   - 人に上げる場面（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方。ガードレール・`delegateMergeExclude`・`harness.config.json` に触れる、守りを弱める、データを壊しうる、など）に当たらなければ、聞かずに計画を出し直すと決め、`node harness/scripts/agent.ts post-judgment <Issue番号> <ファイル>`（`stage` は `scope`、`basis` は `fixable`）で「セッションの判定」を残す。`node harness/scripts/agent.ts release <PR番号>` で PR の宣言を解除し、`claim <Issue番号> --manual --stage plan` で段階を `plan` に戻して、[plan](../plan/SKILL.md) の skill で計画を出し直す（批評と計画ゲートを通し直す）。通ったら、Issue に残る宣言（`post-plan` が出し直す `plan-gate` の宣言）を `release <Issue番号>` で解除してから `claim <PR番号> --manual --stage fix` で宣言し直し、既にある worktree で（手順2をやり直さずに）手順3から続ける。
   - 人に上げる場面に当たるときは、人に返す（今までどおり）。人が付き添うセッションだけは、範囲外のまま直すか計画を出し直すかを AskUserQuestion で聞いてよい（聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。範囲外のまま直すと決まったら、理由を PR のコメントに書く。
   - fleet から起こされた ship が直しを任せたサブエージェントは、書かずに止まって理由を返す（[ship](../ship/SKILL.md) の skill の「実装のモデル」の節。ship が段階を `plan` に戻す）。
4. テストの assert の行を書き換える・消す必要があるときは、書き方を変えて改ざん検査（`agent/tests`）を逃れない。理由を Issue か PR にコメントする。自動 Merge の対象の PR のときは、人に `test:exempt` を付けてもらうよう頼む（自分では付けない）。Human Merge の PR では `test:exempt` は要らない（`agent/tests` は neutral になり、人が Merge の前に理由と行を確かめる）。
5. `node harness/scripts/agent.ts check-changed` を通す（変更したファイルに関係するテストだけを流す。全体のテストは judge の⑧と CI が流す）。`project.checkCommand` が `null` なら省く。
6. push の前に `node harness/scripts/agent.ts ensure-claim <PR番号>` を流す（宣言の持ち主と、PR が開いていることを確かめる）。止まったら push せずに `release <PR番号>` して終え、一覧に同じく書く。流せたら `git add <ファイル>` でファイルを指定して commit し、`git push origin <PR のブランチ>` で push する（`<PR のブランチ>` は手順2と同じ。force push しない。main への追従が要るなら sync の手順で merge する）。
7. 何を直したかを PR にコメントする（先頭に `<!-- agent-harness:claude -->`）。
8. `node harness/scripts/agent.ts release <PR番号>` で着手を解除する。
9. judge の手順で判定をやり直す（再レビュー。前回の判定の head からの差分と前回の指摘だけがブロッキングの対象）。

## 終わりの状態

- 指摘を直したコミットが PR のブランチに push され、何を直したかのコメントがある。
- 新しい head への判定が投稿され、App が受け付けている（judge の終わりの状態）。

## 人に返す条件

- 人に上げる場面に当たるとき、[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方の確認事項の (a)(b) なら、確認事項（`stage` はこの段階、`resume` はこの段階、番号はPR）を `node harness/scripts/agent.ts check <ファイル>` の後に `node harness/scripts/agent.ts post-confirm <番号> <ファイル>` で書き、`release <番号>` で宣言を解除して返す（ship・fleet が一覧の「確認事項の答え待ち」に載せる。書式と再開は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方の確認事項の箇条）
- 修正の上限（`agent:blocked`、理由コード `fix-limit`）と Merge 済み・Closed は確認事項で止めない（`step` は `stopped`・`merged` の確認事項を見ない）。答えで再開しても、直近2つの変更要求レビューに同じ指摘があれば `repeated-finding` で止まる
- PR が Merge 済み・Closed（`claim` か `ensure-claim` が止まった。push しない）
- 指摘が要件・AC の変更を求めている、または指摘どうし・計画と食い違う
- 自動 Merge の対象の PR で、テストの assert を変える必要がある（`test:exempt` を頼む。Human Merge の PR では理由を PR に書けば返さなくてよい）
- 計画の `files` の外を変える必要があり、人に上げる場面に当たる（当たらなければ手順3のとおり計画を出し直す）
- 修正回数の上限（App が `agent:blocked`、理由コード `fix-limit`）に達した
- やってはいけないこと：force push、Merge、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge`・auto mode のラベル（既定 `agent:auto-mode`。名前は `harness.config.json` の `autoMode.label`）と `*:exempt` のラベルの付け外し
