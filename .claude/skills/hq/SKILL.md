---
name: hq
description: 人が付き添う Orca のプライマリ（main の checkout）のセッションで、テーマ（Epic）の案を人に承認してもらってから fleet を Orca の worker として起こし、fleet の質問をまとめて人に聞いて返し、進んでいない・止まった fleet を扱い、Epic が Close したらワークスペースを片付ける。ファイルは書き換えない。「hq で進めて」「Epic ごとに fleet を起こして」と頼まれたときに使う。
---

# hq（テーマごとの fleet をまとめて指揮する）

Epic #281 の役割の分け方：hq は Epic と fleet の管理、fleet は Epic の終了、ship は Issue と PR の Close に責任を持つ。人に聞く窓口は hq にまとめる（ship → fleet → hq → 人）。fleet の側の手順は [fleet の skill](../fleet/SKILL.md) の「Orca の worker として動くとき」、各段階の中身は ship と各 skill に従い、ここに写さない。

Orca のコマンドは、orchestration の skill（[.claude/skills/orchestration/SKILL.md](../orchestration/SKILL.md)）の「Resolve the CLI for this session」で決めた実行ファイルを使う（下では `ORCA` と書く。そのまま打たずに置き換える）。細部とフラグは `ORCA skills get orchestration` の、版に合った案内に従う（起こし直し・片付けは `--reference references/recovery-and-cleanup.md`）。

**Orca が無い環境**（`ORCA status --json` が動かない、Orca の外のセッション）では hq を使わない。今までどおり fleet・ship をそのまま使う（fleet は orchestration の前置きが無いので、AskUserQuestion で人に聞く）。

## 入力

- 進めたい Epic・Issue（任意）。無ければ開いた Epic（`epic` のラベル。子課題は App の記録 `kind=epic-split`）と、Epic に入っていない開いた Issue から案を作る
- 同時に動かす fleet の上限：`node harness/scripts/panes.ts config` の `maxFleets`（`hq.maxFleets`、既定 2）
- 進んでいない fleet のしきい値：`hq.staleSnapshotMinutes`（既定 30 分）・`hq.stuckMinutes`（既定 120 分）。`node harness/scripts/panes.ts fleets --session <ID>...` が使う
- fleet の対応の控え：scratchpad の `hq-fleets.json`（テーマ・Dispatch ID・fleet のセッション ID・ワークスペースのパス・fleet ごとの Issue 番号の集合。今動いている fleet だけ。手順8の止まったタスクの見回しで聞いたものと、読んだ Epic の子の一覧も残す）

## 手順

1. **本体で動く**：`ORCA worktree current --json` の `isMainWorktree` が true であることを確かめる（hq は Orca のプライマリ＝main の checkout で動かす。専用の worktree だとブランチが main から遅れ、古いハーネスで動くため）。false なら止めて人に返す。表示名を `ORCA worktree set --worktree path:<本体の絶対パス> --display-name hq` で `hq` にする。始める前に `git pull --ff-only` で最新にする。
2. **hq は書き換えない**：hq はリポジトリのファイル（本体・fleet のワークスペース・Issue の worktree）を書き換えない。するのは、読むこと（`gh`・`node harness/scripts/agent.ts fleet-status`・`panes.ts`・`node harness/scripts/agent.ts usage`・Orca の読むコマンド）、指揮（Orca の orchestration）、GitHub への記録（コメント・着手宣言）と、人が承認した案だけの Epic の Issue の作成と sub-issues への付け足し（手順8の止まったタスクの見回し）だけ。一時ファイルは scratchpad にだけ書く。唯一の書き込みは、手順5の印のファイル。fleet も書き換えない（fleet の skill の「Orca の worker として動くとき」の4）。コードや docs を書き換えるのは、Issue の worktree の中の ship だけ。
3. **テーマの案 → 人の承認**：テーマは Epic（fleet のワークスペースは Epic ごとに1つ）。開いた Epic と子課題を `node harness/scripts/agent.ts fleet-status <子課題の番号>...` で読み、依存の鎖・`area:*`・計画の `files` の重なりから、「どの Epic を進めるか／Epic に入っていない Issue をどう Epic にまとめるか」の案を作る。テーマどうしで `files` が重なる組は、同時に起こさない案にする。案は AskUserQuestion で人に聞き、承認をもらう（おすすめを先頭、1回に4問まで。聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。Epic にまとめるために Issue を新しく作るかは人が決める。人が承認しなかったテーマは起こさない。
4. **fleet の起動**：`ORCA status --json` で Orca を確かめ、`ORCA orchestration run-create --objective "<承認されたテーマ>" --json` で Run を1つ作る（hq の Run。Run ID を控えの `hq-fleets.json` にも書く）。テーマごとに次で fleet を起こす。
   ```text
   ORCA orchestration worker-start --spec "<指示>" --worktree new-top-level --agent claude --display-name "fleet: #<Epic番号> <短い名前>" --comment "Epic #<Epic番号>" --run <hq の Run ID> --json
   ```
   - 指示に入れるもの：fleet の skill の「Orca の worker として動くとき」に従うこと、`fleet-status` に渡す Issue 番号の集合、テーマの名前（ペインの `--label`。表示名の `fleet: ` の後ろ）、最初に自分のセッション ID（`AGENT_HARNESS_SESSION`）を `send`（件名 `session`）で hq に返すこと。名前は表示のためだけで、着手宣言・usage・`fleet-status` はセッション ID で見分ける。
   - 同時に動く fleet（`ORCA orchestration worker-list --run <hq の Run ID> --json` で settle していない Dispatch）は `hq.maxFleets` を超えない。fleet が ship を Orca の worker で動かすとき（fleet の skill の「Orca の worker で ship を動かすとき」）、ship の worker は fleet の Run にいるので、`--run` で絞れば数に入らない。上限に達していれば、次のテーマは起こさずに待ち、1つが片付いてから起こす。
   - `worker-start` が 0 以外で終わったら起こし直さない。受け取りの `failedStage`・`residualResources` を読み、`references/recovery-and-cleanup.md` に従う。
   - 受け取ったら、テーマ・Dispatch ID・ワークスペースのパスを scratchpad の `hq-fleets.json` に書く。fleet から `session` が届いたら、そのセッション ID も書く。控えが消えたら（hq の `/clear`・交代）、`ORCA orchestration worker-list --run <hq の Run ID> --json` で settle していない Dispatch ごとに `send` でセッション ID を聞き直して作り直す。テーマの名前（label）だけでセッションを引かない。
5. **印を置く**：fleet のワークスペースを作った直後に、Write で `<ワークスペースの絶対パス>/.agent-harness-workspace` を置く（中身はテーマの名前1行）。まだ印が無いので hook（`.claude/hooks/workspace-guard.ts`）に止められない。書き先は main の checkout の外（fleet のワークスペースの中）の絶対パスにする。印は `.gitignore` に入っているので、ワークスペースの `git status` に出ない。これ以降、ワークスペースの中の書き換えは hook が止める。
6. **ペイン**：hq の Claude のターミナルを `ORCA terminal split --terminal <hq の handle> --json` で分け、`ORCA terminal send --terminal <新しい handle> --text "node harness/scripts/panes.ts hq --session <ID> --session <ID>" --enter` を送る（テーマごとの要約と、全 fleet の「あなたがすること」）。`--session` には控えの今動いている fleet のセッション ID だけを渡す。fleet が増えた・減った・起こし直したら、そのペインを閉じて作り直す。
7. **人の判断をまとめて聞く**：`ORCA orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json` で待つ。
   - `question`：ほかの fleet の分もまとめて AskUserQuestion で聞く（1回に4問まで。fleet の選択肢の順（おすすめが先頭）を変えず、質問にテーマの名前を添える）。答えは `ORCA orchestration reply --id <message_id> --body "<人の答え>" --json` で返す。本文は人の答え（選んだ項目と書き添えた文、人の言葉のまま）だけで、hq の説明や要約を足さない。人が拒んだ・答えなかったら、本文を `答え無し` にして返す（fleet は各 skill の「人が答えなかった」の扱いにする）。同じ質問を人に繰り返さない。
   - `escalation`：理由を人に示し、手順12の一覧に書く。
   - `worker_done`：手順9。
   - 届いたものを全部処理してから `--ack <delivery_id>` する。
8. **進んでいない fleet を見つける**：`check --wait` が空で返るたび（15分ごと）に、`node harness/scripts/panes.ts fleets --session <今動いている fleet のセッション ID>...` を読む。`--session` なしで読まない（終わった・解放した・起こし直す前の fleet のスナップショットも OS の一時ディレクトリに残るため）。
   - `stalled` が true の fleet：`staleSnapshot`（スナップショットの `at` が `hq.staleSnapshotMinutes` より古い＝collect が止まっている）、`missing`（スナップショットが無い）、`stuck`（AI の番の行の `since` が `hq.stuckMinutes` より長い＝進んでいない）。
   - hq がまだ答えていない `question` のある Issue の行は、人の答え待ちなので `stuck` から外して数える。
   - 起こし直さず、`ORCA orchestration send --to dispatch:<Dispatch ID> --subject "状況の確認" --body "<何が古い・長いか>。今の状況を hq に返してください" --json` で状況を聞く（Orca の `ask` は worker から coordinator への問いなので、hq から聞くのは `send`。fleet は段階の切れ目の `check` で読む）。同じ fleet に同じ理由で聞くのは、状況が変わるまで1回。
   - 次の待ち（15分）の間にその fleet から何も届かなければ、人に知らせる（テーマ・何が古い／長いか・経った時間）。窓口は hq。
   - **止まったタスクの見回し**（同じ回に、fleet の外で止まっているものを見つけて割り振る。#407）：
     - 読むもの（GitHub の API を使いすぎないため、この3つだけ。Issue・PR を1件ずつ `gh` で読みに行かない）：
       - ダッシュボードの節：ダッシュボード Issue（`harness.config.json` の `dashboardIssueTitle`）の本文を1回読む。使うのは「人の対応待ち」の「引き継ぐか決める」（#371）・「停滞している Agent PR」・「停滞している Issue」と、止まった着手宣言の節（#391。まだ無ければ読まない）。
       - patrol の結果（#370）：`node harness/scripts/agent.ts arch-review-pending` と `node harness/scripts/qa-retro-loop.ts pending` の未採用の下書きの数。hq は割り振らず、数を手順12の一覧に出すだけ（Issue にするかは今までどおり人が「〜の下書きを選ぶ」で決める）。
       - `fleet-status` の結果：番号を渡さない `node harness/scripts/agent.ts fleet-status --json` と、控えの各 fleet の Issue 番号の集合。番号なしの対象は `fleetTargets`（`agent:ready`・`agent:plan-ok`・`agent:plan-review` と、`agent:*` の無い開いた Issue）だけで、`agent:blocked`・`agent:hold`・`agent:waiting` などの Issue は入らない（下の「どの fleet にも入っていない開いた Issue」はこの範囲。止まった宣言・担当のいない PR はダッシュボードの節で拾う）。
       - 上の3つの外の読み取りは、開いた Epic の子の一覧（App の記録 `kind=epic-split` と GitHub の sub-issues）だけ。「Epic に入っていない単発の Issue」を見つけるのに要る。`fleet-status` の行に「どの fleet にも入っていない」候補があるときだけ、開いた Epic ごとに1回読み、控えに残して、次の回は Epic の数か更新が変わったときだけ読み直す。
     - 見つけるもの4つ：
       - **担当のいない PR**：着手宣言が無い・解除された・古い開いた Agent PR（ダッシュボードの「引き継ぐか決める」「停滞している Agent PR」と、`fleet-status` の行の PR の着手宣言）
       - **止まった宣言**：ダッシュボードの止まった宣言の節（#391）と、`fleet-status` のメモの着手宣言のうち、控えのどの fleet のセッションでもないもの
       - **どの fleet にも入っていない開いた Issue**：`fleet-status --json` の行のうち、控えのどの fleet の Issue 番号の集合にも無いもの
       - **Epic に入っていない単発の Issue**：開いた Epic の子（`kind=epic-split` と sub-issues）に無いもの。fleet で進んでいても sub-issues に無いもの（#373 の例）も含む
     - 前の回と同じものは数え直すだけにし、人に同じことを繰り返し聞かない（控えに聞いたものを残す）。
     - 割り振り（hq が決めて、手順12の一覧でまとめて知らせる）：
       - 今の fleet の Epic に入るもの（その Epic の子課題）：その fleet に `ORCA orchestration send --to dispatch:<Dispatch ID> --subject "Issue の追加" --body "fleet-status に渡す集合に #<番号> を足してください" --json` で渡し、控えの Issue 番号の集合にも足す（fleet は fleet の skill の「hq からの追加の指示」で読む）。
       - 入らないもの：`hq.maxFleets` に空きがあれば、新しい fleet（テーマ）の案にする。起こすのは今までどおり手順3の人の承認の後。空きが無ければ、手順12の一覧に「空き待ち」として出す。
       - 止まった宣言・担当のいない PR：引き継ぐかは人が決める。hq は自分で引き継がず、見つけたものを1回にまとめて AskUserQuestion で聞く（引き継ぐなら、手順10と同じく受け持つ fleet の指示に `--takeover` での出し直しを書く）。
     - Epic の案（hq は案まで、決めるのは人）：
       - 「単発の #… を Epic #… に」「この3件で新しい Epic を」の案を作り、引き継ぎの問いと一緒に AskUserQuestion で1回に聞く（おすすめを先頭、1回に4問まで、残りは次の回か手順12の一覧に。手順3の「Epic にまとめるために Issue を新しく作るかは人が決める」と同じ）。
       - 承認されたら、新しい Epic の Issue は intel（#396）がいれば intel に作らせ、いなければ hq が `gh issue create` で作る（作るだけ。計画・fleet の起動は手順3・4の承認のとおり）。
       - 子課題としての付け足し（GitHub の sub-issues）は、人が承認した案だけ hq が足す（人の決定：「承認した案だけ hq が足す」）。承認されていない Issue は足さない。
       - 承認されなかった案は、次の回に同じ案を繰り返さない。
9. **fleet が終わっても Epic は終わりではない**：`worker_done` は、控えの Dispatch と同じかを確かめてから受け取り、`--report-path` のファイルを読む。fleet が人の Merge 待ちで返っても、終わったとみなさない。Epic が開いていれば（人の Merge 待ち・人の判断待ちが残る）、ワークスペースを残す。worker は `ORCA orchestration worker-release --dispatch <Dispatch ID> --json` で解放し、控えから外す。Merge などで進められる子課題が出たら（`fleet-status` に「選ぶ」がある）、同じワークスペース（`--worktree path:<ワークスペースの絶対パス>`）に新しい fleet を起こす。新しい fleet はセッション ID が変わるので、手順10の引き継ぎの問いと同じく聞く。
10. **止まった fleet の起こし直し**：
    - 起こし直すのは、`ORCA orchestration worker-list --include-remote --run <hq の Run ID> --json` の `projection.liveness` が `exited` のときだけ。`unverifiable`（absence を含む）は止まった証拠にしない（待ち続けるか、読んで確かめる）。
    - 同じ fleet（同じテーマ）は1時間に2回まで。起こし直したら Epic に hq の記録のコメント（先頭に目印 `<!-- agent-harness:hq-restart theme=<Epic番号> -->`、本文に時刻・前と新しいセッションの短い ID・理由 `exited`）を残し、回数は同じ目印のコメントの直近1時間の件数で数える（hq の `/clear`・交代で scratchpad が消えても数え直しにならない）。超えたら起こし直さず、人に知らせる。
    - 起こし直す前に、前の fleet のセッションの着手宣言（`fleet-status` のメモの「着手宣言」と session）を数え、「前の fleet（session <短い ID>）の宣言 #…（N 件）を新しい fleet に引き継ぐか」を AskUserQuestion で1問だけ聞く（1件ずつ聞かない。引き継ぎは人が決める）。
    - 引き継ぐなら、新しい fleet の指示に「人の決定：前の宣言を引き継ぐ」と、Issue の段階は `node harness/scripts/agent.ts claim <番号> --manual --stage <段階> --takeover`、PR の段階は `node harness/scripts/agent.ts claim <PR番号> --manual --stage judge|fix|sync --takeover` で出し直すことを書く。fleet が `ask` で引き継ぎを聞いてきたら、人の同じ答えを `reply` で返し、人に聞き直さない。引き継がないなら、その Issue を指示から外し、手順12の一覧に書く。
    - 止め方と新しい Dispatch（`worker-stop`・`worker-abandon`、`worker-start --task <task_id> --retry-of <dispatch_id>`、同じワークスペース）は `references/recovery-and-cleanup.md` に従う。起こし直したら控えとペインを直す。
11. **片付け**：Epic が Close した（`gh issue view <Epic番号> --json state` が `CLOSED`）テーマだけを片付ける。fleet の worker を `worker-release` で解放し、控えから外してペインを作り直し、`ORCA worktree rm --worktree path:<ワークスペースの絶対パス> --json` でワークスペースを消す。人の判断待ちだけが残るとき（Epic が開いている）は残す。
12. **人がすることの一覧**：各 fleet の `worker_done` のレポートと `panes.ts hq` の一覧を1つにまとめて人に出す（Merge・例外ラベル・`setup.ts` の要否・Merge 後の確かめ・人の判断待ち・進んでいない fleet・起こし直しの上限を超えた fleet・引き継がなかった宣言）。手順8の止まったタスクの見回しからは、割り振ったもの（どの fleet に渡したか）・案として聞いたもの（Epic の案・引き継ぎの問い）・人が決めなかったもの（答え無し・拒まれた・空き待ち）と、patrol の未採用の下書きの数を足す。費用は手順8の `panes.ts fleets --session` の各行の `totalUsd` と、hq 自身の `node harness/scripts/agent.ts usage` をまとめる。

## 終わりの状態

- 承認されたテーマの fleet が、Epic の Close で片付いたか、人の Merge 待ち・人の判断待ちでワークスペースを残している。
- 同時に動いた fleet は `hq.maxFleets` を超えていない。
- 人がすることの一覧（費用を含む）を出した。

## 人に返す条件

- `isMainWorktree` が false（本体で動いていない）
- Orca のコマンドが動かない（エラーをそのまま示す。別の実行ファイルに切り替えない）
- 起こし直しの上限（1時間に2回）を超えた
- 進んでいない fleet に状況を聞いても答えが無い
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge`・auto mode のラベル（既定 `agent:auto-mode`。名前は `harness.config.json` の `autoMode.label`）と `*:exempt` のラベルの付け外し、main への push、Issue 本文の書き換え、本体・fleet のワークスペースの書き換え（印を除く）
