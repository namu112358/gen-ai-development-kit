---
name: hq
description: 人が付き添う Orca のプライマリ（main の checkout）のセッションで、テーマ（Epic）の案を人に承認してもらってから fleet を Orca の worker として起こし、fleet の質問をまとめて人に聞いて返し、進んでいない・止まった fleet を扱い、Epic が Close したらワークスペースを片付ける。リポジトリのファイルは書き換えない。「hq で進めて」「Epic ごとに fleet を起こして」と頼まれたときに使う。
---

# hq（テーマごとの fleet をまとめて指揮する）

Epic #281 の役割の分け方：hq は Epic と fleet の管理、fleet は Epic の終了、ship は Issue と PR の Close に責任を持つ。人に聞く窓口は hq にまとめる（ship → fleet → hq → 人）。fleet の側の手順は [fleet の skill](../fleet/SKILL.md) の「Orca の worker として動くとき」、各段階の中身は ship と各 skill に従い、ここに写さない。

Orca のコマンドは、orchestration の skill（[.claude/skills/orchestration/SKILL.md](../orchestration/SKILL.md)）の「Resolve the CLI for this session」で決めた実行ファイルを使う（下では `ORCA` と書く。そのまま打たずに置き換える）。細部とフラグは `ORCA skills get orchestration` の、版に合った案内に従う（起こし直し・片付けは `--reference references/recovery-and-cleanup.md`）。

**Orca が無い環境**（`ORCA status --json` が動かない、Orca の外のセッション）では hq を使わない。今までどおり fleet・ship をそのまま使う（fleet は orchestration の前置きが無いので、AskUserQuestion で人に聞く）。

## 入力

- 進めたい Epic・Issue（任意）。無ければ開いた Epic（`epic` のラベル。子課題は App の記録 `kind=epic-split`）と、Epic に入っていない開いた Issue から案を作る
- 同時に動かす fleet の上限：`node harness/scripts/panes.ts config` の `maxFleets`（`hq.maxFleets`、既定 2）
- 進んでいない fleet のしきい値：`hq.staleSnapshotMinutes`（既定 30 分）・`hq.stuckMinutes`（既定 120 分）。`node harness/scripts/panes.ts fleets --session <ID>...` が使う
- fleet の対応の控え：git の共通ディレクトリ（`git rev-parse --path-format=absolute --git-common-dir`）の下の `agent-harness/hq/hq-fleets.json`（#409。hq が落ちても新しい hq が読めるように、scratchpad には置かない。読むのは `node harness/scripts/hq-state.ts ledger`、書くのは scratchpad に書いた JSON を `node harness/scripts/hq-state.ts ledger-save <ファイル>` で置く。書き換えの場所の見張りの hook が `.git` の中への Write を止めるので、Write で直接書かない。中身は hq の Run ID `runId`・hq の Claude の端末 `hqHandle`・hq のセッション ID `hqSession`・hq のペインの handle `paneHandles`・`fleets`（今動いている fleet だけ。1つの fleet は `{ "theme": "<テーマ>", "epic": <Epic番号> | null, "dispatch": "<Dispatch ID>", "session": "<fleet のセッション ID>" | null, "workspace": "<ワークスペースのパス>", "startedAt": "<起こした時刻 ISO>", "issues": [<Issue 番号>...] }`。`session` は届くまで null。手順6の hq のペインはこの `fleets` の `session` からスナップショットを読むので、起こし直し・片付けで書き換えればペインが追う。手順8の止まったタスクの見回しで聞いたものと、読んだ Epic の子の一覧も残す）
- hq がいない間に fleet が控えた質問：同じディレクトリの `agent-harness/hq/pending/<fleet のセッション ID>.json`（`node harness/scripts/hq-state.ts pending --all` で読む。書くのは fleet。fleet の skill の「Orca の worker として動くとき」の 5 の「hq がいないとき」）
- heartbeat の一言の控え：同じディレクトリの `agent-harness/hq/hq-heartbeat.json`（書くのは hq の `node harness/scripts/hq-state.ts heartbeat-save`、読むのはログのペイン。#438）

## 手順

1. **本体で動く**：`ORCA worktree current --json` の `isMainWorktree` が true であることを確かめる（hq は Orca のプライマリ＝main の checkout で動かす。専用の worktree だとブランチが main から遅れ、古いハーネスで動くため）。false なら止めて人に返す。表示名を `ORCA worktree set --worktree path:<本体の絶対パス> --display-name hq` で `hq` にする。始める前に `git pull --ff-only` で最新にする。
   - **前の hq の引き継ぎ**（#409。ほかの手順の前に行う）：`node harness/scripts/hq-state.ts ledger` で控えを読む。
     - 控えがあり、`hqSession` が自分でない：控えの `hqHandle` を `ORCA terminal show --terminal <hqHandle> --json` で読む。live なら前の hq が動いているので、始めずに人に返す（hq を2つ動かさない。前の hq が応答しない（固まった）なら、人が前の hq のタブを閉じてから `/hq` を呼び直す）。無ければ `ORCA orchestration run-use --id <runId> --json` で前の Run をこの端末に結び直し、`node harness/scripts/hq-state.ts pending --all` で fleet の控えを読んでから、`check` の未処理（`question`・`escalation`・`worker_done`）を手順7のとおり処理する。控えで答え済み（`answer` がある）の質問には、人に聞かずに本文 `fleet のタブで人が答え済み` で返す（返し方は手順7）。`ORCA orchestration worker-list --run <runId> --json` の settle していない Dispatch ごとに `ORCA orchestration send --to dispatch:<Dispatch ID> --subject "hq-back" --body "hq が戻りました（session <短い ID>）" --json` で戻ったことを知らせ、控えの `hqHandle`・`hqSession`・`paneHandles`（手順6で作り直したもの）を自分のものにして `hq-state.ts ledger-save` で置く。
     - `run-use` が失敗した（Run が消えた・結べない）：手順4のとおり新しい Run を作り、fleet の控えの答えの無い質問を手順12の一覧に「fleet のタブ（テーマ）で答える」として出す（fleet は hq がいないときの退行のまま、人の答えを fleet のタブで受ける）。
     - 控えが無い（または `hqSession` が自分）：今の手順（手順4の `worker-list` で聞き直す）で作り、`hq-state.ts ledger-save` で置く。
2. **hq は書き換えない**：hq はリポジトリのファイル（本体・fleet のワークスペース・Issue の worktree）を書き換えない。するのは、読むこと（`gh`・`node harness/scripts/agent.ts fleet-status`・`panes.ts`・`node harness/scripts/agent.ts usage`・Orca の読むコマンド）、指揮（Orca の orchestration）、GitHub への記録（コメント・着手宣言）、intel への `SendMessage` と intel のタブの起こし方（本体での `ORCA terminal create`・`terminal send`。節「相談・アイデアを intel に回す」）と、人が承認した案だけの Epic の Issue の作成と sub-issues への付け足し（手順8の止まったタスクの見回し）だけ。リポジトリの中で書くのは印のファイルだけ（手順5の `.agent-harness-workspace`）。リポジトリの外の控え（scratchpad の一時ファイルと、スクリプトが git の共通ディレクトリの下に置く状態（段階のファイル・`hq-state.ts` の控え・`hq-heartbeat.json`））は書く（作業ツリーの外で、書き換えに数えない）。fleet も書き換えない（fleet の skill の「Orca の worker として動くとき」の4）。コードや docs を書き換えるのは、Issue の worktree の中の ship だけ。
3. **テーマの案 → 人の承認**：テーマは Epic（fleet のワークスペースは Epic ごとに1つ）。開いた Epic と子課題を `node harness/scripts/agent.ts fleet-status <子課題の番号>...` で読み、依存の鎖・`area:*`・計画の `files` の重なりから、「どの Epic を進めるか／Epic に入っていない Issue をどう Epic にまとめるか」の案を作る。テーマどうしで `files` が重なる組は、同時に起こさない案にする。案は AskUserQuestion で人に聞き、承認をもらう（おすすめを先頭、1回に4問まで。聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。Epic にまとめるために Issue を新しく作るかは人が決める。人が承認しなかったテーマは起こさない。
4. **fleet の起動**：`ORCA status --json` で Orca を確かめ、`ORCA orchestration run-create --objective "<承認されたテーマ>" --json` で Run を1つ作る（hq の Run。Run ID と hq の Claude の端末の handle を控えの `hq-fleets.json` に書き、`hq-state.ts ledger-save` で置く）。テーマごとに次で fleet を起こす。
   ```text
   ORCA orchestration worker-start --spec "<指示>" --worktree new-top-level --agent claude --display-name "fleet: #<Epic番号> <短い名前>" --comment "Epic #<Epic番号>" --run <hq の Run ID> --json
   ```
   - 指示に入れるもの：fleet の skill の「Orca の worker として動くとき」に従うこと、`fleet-status` に渡す Issue 番号の集合、テーマの名前（ペインの `--label`。表示名の `fleet: ` の後ろ）、最初に自分のセッション ID（`AGENT_HARNESS_SESSION`）を `send`（件名 `session`）で hq に返すこと、heartbeat の本文に今の状況を一言入れること（Issue 番号・段階・次にすること・待っているもの。fleet の skill の「Orca の worker として動くとき」の 6）。名前は表示のためだけで、着手宣言・usage・`fleet-status` はセッション ID で見分ける。
   - 同時に動く fleet（`ORCA orchestration worker-list --run <hq の Run ID> --json` で settle していない Dispatch）は `hq.maxFleets` を超えない。fleet が ship を Orca の worker で動かすとき（fleet の skill の「Orca の worker で ship を動かすとき」）、ship の worker は fleet の Run にいるので、`--run` で絞れば数に入らない。上限に達していれば、次のテーマは起こさずに待ち、1つが片付いてから起こす。
   - `worker-start` が 0 以外で終わったら起こし直さない。受け取りの `failedStage`・`residualResources` を読み、`references/recovery-and-cleanup.md` に従う。
   - 受け取ったら、テーマ・Epic 番号・Dispatch ID・ワークスペースのパス・起こした時刻（`startedAt`）・Issue 番号の集合を控えの `hq-fleets.json` に書いて `hq-state.ts ledger-save` で置く。fleet から `session` が届いたら、そのセッション ID も書く。控えが無い・壊れた（`hq-state.ts ledger` が `null`）ときは、`ORCA orchestration worker-list --run <hq の Run ID> --json` で settle していない Dispatch ごとに `send` でセッション ID を聞き直して作り直す。テーマの名前（label）だけでセッションを引かない。
5. **印を置く**：fleet のワークスペースを作った直後に、Write で `<ワークスペースの絶対パス>/.agent-harness-workspace` を置く（中身はテーマの名前1行）。まだ印が無いので hook（`.claude/hooks/workspace-guard.ts`）に止められない。書き先は main の checkout の外（fleet のワークスペースの中）の絶対パスにする。印は `.gitignore` に入っているので、ワークスペースの `git status` に出ない。これ以降、ワークスペースの中の書き換えは hook が止める。
6. **ペイン**（#402）：hq が呼び出されたら（手順1の引き継ぎの後、fleet を起こす前に1回）、本体のワークスペースを次の並びで開く。左に hq の Claude（縦いっぱい）、真ん中の列に上から ① Epic/Issue → ② 人待ち → ③ ログ、右に intel の Claude（並びは #430 の人の決定「hq のペインもEpic 、進捗を一番上にしてほしい」）。
   ```text
   ┌──────────────┬──────────────────────┬──────────────┐
   │              │ ① Epic/Issue         │              │
   │  hq の       ├──────────────────────┤  intel の    │
   │  Claude      │ ② 人待ち              │  Claude      │
   │              ├──────────────────────┤              │
   │              │ ③ ログ                │              │
   └──────────────┴──────────────────────┴──────────────┘
   ```
   - 作り方：`ORCA terminal split --terminal <hq の handle> --direction vertical --json` で右に分けて真ん中の列を作る。intel を開くときは、先に真ん中の列を `ORCA terminal split --terminal <真ん中の handle> --direction vertical --json` で右に分けて intel の列を作る（縦いっぱいにするため、上下に分ける前に分ける）。その後、真ん中の handle を `ORCA terminal split --terminal <真ん中の handle> --direction horizontal --json` で2回分けて上下に3つにする。上から順に `ORCA terminal send --terminal <handle> --text "node harness/scripts/panes.ts hq board" --enter`（① Epic/Issue：Epic のページと Issue のページを Tab・e・i で切り替える）、`node harness/scripts/panes.ts hq todo`（② 人待ち：全 fleet の人がすること）、`node harness/scripts/panes.ts hq log`（③ ログ：状態が変わった Issue を新しい順に）を送る。
   - 向き：最初は Orca 1.4.216 の実際の動き（`orca-cli` の案内（「`--direction horizontal` splits left/right」）とは逆で、`--direction vertical` で左右、`--direction horizontal` で上下）で分ける。最初から案内に合わせて `vertical` と `horizontal` を入れ替えない（#430。案内に従って下に開いた）。向きは決め打ちにしない（#448）：1回分けるたびに、下の「分けた後の確かめ」で並びを見る。左右に分けたいのに上下になった（上下に分けたいのに左右になった）ら、そのとき分けたペインだけを閉じて逆の向きの `--direction` で分け直す。逆の向きで正しく分かれたら、残りの分け方も左右と上下の `--direction` を入れ替えて使う（Orca が案内どおりの向きに直っても崩れないように）。
   - 分けた後の確かめ：コマンドを送る前・intel を起こす前に、1回分けるたびに `ORCA terminal list --worktree current --include-visual-layouts --json` のペインの木（`visualLayouts` の `panes`）で、新しい分け目の `direction`（`vertical` が左右、`horizontal` が上下）が狙いどおりかを見る（ペインの木の `direction` は分かれた結果の向きで、`--direction` の指定とは別に読む）。全部分けた後に、hq の Claude の handle が `direction` が `vertical` の分け目の `first`（左）で、intel を開くなら真ん中の列と intel の列が `vertical` の分け目（intel が `second`、右）、真ん中の列が `horizontal` の分け目で上（`first`）から Epic/Issue → 人待ち → ログ の handle の順になっているかを確かめる。違えば、閉じてよいのはそのとき分けたペインだけ（①〜③と、intel を起こす前の空のペイン）で、`ORCA terminal close --terminal <handle>` で閉じ（閉じる前の確かめは下の「自分の端末を閉じない」のとおり）、逆の向きで作り方から分け直す。分け直しは fleet と同じく合わせて2回まで。2回分け直しても違えば、作った表示のペインを閉じて表示のペイン無しで進める（hq の Claude だけで動く。intel は節「相談・アイデアを intel に回す」の `ORCA terminal create` のタブの起こし方に回す）。intel が既に動いているペイン・hq 自身の Claude の端末は閉じない。確かめと分け直しは、コマンドを送る前・intel を起こす前に終える。intel を起こした後はこの確かめに戻らず、分け直さない（intel のペインを閉じないため）。起こし直しなどで intel が既にいるとき（既にいれば右の列を分けないとき）も、intel のペインは閉じる対象に入れず、分け直すのは①〜③だけにする。
   - intel のペイン：節「相談・アイデアを intel に回す」の起こし方で、intel がまだいなければ、上の作り方で分けた右の列で intel を起こす（既にいれば右の列を分けない）。intel の skill（`.claude/skills/intel/SKILL.md`）が無い・起こせないときは、intel のペインを開かずに進める（hq の Claude と①〜③だけで動く）。
   - 3つのペインは fleet を自分で見つける：hq の控え（`hq-fleets.json` の `fleets`）を数秒ごとに読み直し、各 fleet の `session` のスナップショットを読む。コマンドに fleet のセッション ID を渡さない。fleet が増えた・減った・起こし直したときは控えを直すだけで、ペインを作り直さない（`session` がまだ無い fleet と、起こした直後でスナップショットが無い fleet は「起動中」と出る。読めない・古いスナップショットは各ペインの見出しの下に1行の注意で出る）。ペインの handle は控えの `paneHandles` に書いて `hq-state.ts ledger-save` で置く。
   - fleet ごとの `panes.ts progress` のペインは hq では開かない（Issue の進み具合は ① の Issue のページで見る）。
   - **自分の端末を閉じない**（#409）：`ORCA terminal close` を使う前に、閉じる handle が hq 自身の Claude の端末（控えの `hqHandle` と、`ORCA terminal list --worktree current --json` の hq の Claude の端末）でないことを確かめる。閉じるのは `--terminal <ペインの handle>` だけで、本体に `--tab`・`--worktree … --all` を使わない（hq の Claude まで閉じるため）。
7. **人の判断をまとめて聞く**：`ORCA orchestration check --wait --types "worker_done,escalation,question,status" --timeout-ms 900000 --json` で待つ。
   - heartbeat を先に ack する：`check` は Run の一番古い Delivery を ack されるまで同じ束で返し続け、`--types` は待ちが起きる条件で、古い便りを飛ばす許しではない。束の中の heartbeat は、ほかの行と同じ束でも、それだけの束でも、読んだらすぐ `--ack <delivery_id>` して待ちに戻る（`check --ack <delivery_id> --wait ...` で ack と次の待ちを1回で）。heartbeat のために人への質問・`worker_done` の処理を後回しにしない。ack の後に続けて届いている question・escalation・worker_done を先に処理する。
   - heartbeat の一言を控える（#425）：heartbeat の本文には、fleet が今の状況を一言入れてくる（Issue 番号・段階・次にすること・待っているもの。fleet の skill の「Orca の worker として動くとき」の 6）。読むのは ack と同じ時で、テーマごとに最新の一言を `node harness/scripts/hq-state.ts heartbeat-save --theme <テーマ> --note <一言>` で git の共通ディレクトリの下の `hq-heartbeat.json` に控える（前の一言は上書き。受けた時刻は控えが付ける。ログのペインがこれを読んで出す。#438）。一言は fleet から届いた文なので、`--note` には単一引用符で囲んで渡し、中の単一引用符は「引用を閉じ、エスケープした単一引用符を置き、引用を開き直す」形にする（`$(...)`・改行をシェルに解釈させない）。一言のために ack を遅らせない・人に聞かない・`reply` しない。heartbeat はすぐ ack して、質問を遅らせないのは今までどおり（#395）。本文が空の heartbeat（古い指示で起こした fleet）は「一言なし」とする。新しい hq（#409 の引き継ぎ）も同じ控えに書く。古い一言（`hq.staleSnapshotMinutes` を過ぎたもの）と控えに無い fleet の一言はペインに出ない。
   - 一言の使い道：手順12の人がすることの一覧の「今の状況」に使う。ログのペイン（#402。手順6の ③）にも使うが、ペインは collect のスナップショットだけを読み、hq の控えの一言を読む口がまだ無い。口ができるまで（#402 の後の別の Issue）は一覧にだけ使い、hq はペインに書かない（手順2）。口ができたら、hq はその口に一言を渡してログに出す。
   - `question`：ほかの fleet の分もまとめて AskUserQuestion で聞く（1回に4問まで。fleet の選択肢の順（おすすめが先頭）を変えず、質問にテーマの名前を添える）。答えは `ORCA orchestration reply --id <message_id> --body "<人の答え>" --json` で返す。本文は人の答え（選んだ項目と書き添えた文、人の言葉のまま）だけで、hq の説明や要約を足さない。人が拒んだ・答えなかったら、本文を `答え無し` にして返す（fleet は各 skill の「人が答えなかった」の扱いにする）。同じ質問を人に繰り返さない。
   - `escalation`：理由を人に示し、手順12の一覧に書く。
   - `worker_done`：手順9。
   - `status`（fleet の skill の「Orca の worker として動くとき」の 8 の途中の報告・連絡）の振り分け：
     - 人にすぐ伝える（文章で。AskUserQuestion ではない）：`ready-<PR>`（人の Merge 待ち。Human Merge か自動 Merge かも添える）と、人の判断が要ると書かれた `notice`。
     - 手順12の一覧にためる：`merged-<PR>`・`verdict-<PR>`・`wait-<Issue>`・そのほかの `notice`。
     - `status` は知らせるだけで、判断の正は GitHub とラベル。
   - 仮の見張りは要らない：人の Merge 待ちは `ready-<PR>` で届くので、hq は `gh pr list` を定期的に読む仮の見張りを置かない。
   - 返せなくなった答え：`reply` が `dispatch_inactive` などで返せない（fleet が settle した）ときは、人の答えを控えの `hq-fleets.json`（キー `undeliveredAnswers`。`hq-state.ts ledger-save` で置く）に残し、手順9で同じワークスペースに新しい fleet を起こすときの指示に「人の決定：#<Issue> の質問への答え」として人の言葉のまま渡す。手順12の一覧にも書く。人に聞き直さない。
   - heartbeat はすぐ ack し、question・escalation・worker_done・status は処理してから `--ack <delivery_id>` する。
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
9. **fleet が終わっても Epic は終わりではない**：`worker_done` は、控えの Dispatch と同じかを確かめてから受け取り、`--report-path` のファイルを読む。fleet が人の Merge 待ちで返っても、終わったとみなさない。Epic が開いていれば（人の Merge 待ち・人の判断待ちが残る）、ワークスペースを残す。worker は `ORCA orchestration worker-release --dispatch <Dispatch ID> --json` で解放し、控えから外して `hq-state.ts ledger-save` で置く。Merge などで進められる子課題が出たら（`fleet-status` に「選ぶ」がある）、同じワークスペース（`--worktree path:<ワークスペースの絶対パス>`）に新しい fleet を起こす。新しい fleet はセッション ID が変わるので、手順10の引き継ぎの問いと同じく聞く。
10. **止まった fleet の起こし直し**：
    - 起こし直すのは、`ORCA orchestration worker-list --include-remote --run <hq の Run ID> --json` の `projection.liveness` が `exited` のときだけ。`unverifiable`（absence を含む）は止まった証拠にしない（待ち続けるか、読んで確かめる）。
    - 同じ fleet（同じテーマ）は1時間に2回まで。起こし直したら Epic に hq の記録のコメント（先頭に目印 `<!-- agent-harness:hq-restart theme=<Epic番号> -->`、本文に時刻・前と新しいセッションの短い ID・理由 `exited`）を残し、回数は同じ目印のコメントの直近1時間の件数で数える（hq の `/clear`・交代でも数え直しにならない）。超えたら起こし直さず、人に知らせる。
    - 起こし直す前に、前の fleet のセッションの着手宣言（`fleet-status` のメモの「着手宣言」と session）を数え、「前の fleet（session <短い ID>）の宣言 #…（N 件）を新しい fleet に引き継ぐか」を AskUserQuestion で1問だけ聞く（1件ずつ聞かない。引き継ぎは人が決める）。
    - 引き継ぐなら、新しい fleet の指示に「人の決定：前の宣言を引き継ぐ」と、Issue の段階は `node harness/scripts/agent.ts claim <番号> --manual --stage <段階> --takeover`、PR の段階は `node harness/scripts/agent.ts claim <PR番号> --manual --stage judge|fix|sync --takeover` で出し直すことを書く。fleet が `ask` で引き継ぎを聞いてきたら、人の同じ答えを `reply` で返し、人に聞き直さない。引き継がないなら、その Issue を指示から外し、手順12の一覧に書く。
    - 止め方と新しい Dispatch（`worker-stop`・`worker-abandon`、`worker-start --task <task_id> --retry-of <dispatch_id>`、同じワークスペース）は `references/recovery-and-cleanup.md` に従う。起こし直したら、控えのその fleet の `session`（新しい fleet から届くまで null）・`startedAt`・`dispatch` を新しい fleet のものに書き換えて `hq-state.ts ledger-save` で置く（手順6のペインは控えを読み直して追うので、作り直さない）。
11. **片付け**：Epic が Close した（`gh issue view <Epic番号> --json state` が `CLOSED`）テーマだけを片付ける。fleet の worker を `worker-release` で解放し、控えから外して `hq-state.ts ledger-save` で置き（手順6のペインは控えを読み直して追うので、作り直さない）、`ORCA worktree rm --worktree path:<ワークスペースの絶対パス> --json` でワークスペースを消す。人の判断待ちだけが残るとき（Epic が開いている）は残す。
12. **人がすることの一覧**：各 fleet の `worker_done` のレポートと `node harness/scripts/panes.ts hq todo --once` の一覧を1つにまとめて人に出す（テーマごとの今の状況（手順7で控えた heartbeat の一言と受けた時刻。一言なしならそう書く）・Merge・例外ラベル・`setup.ts` の要否・Merge 後の確かめ・人の判断待ち・進んでいない fleet・起こし直しの上限を超えた fleet・引き継がなかった宣言・手順7でためた fleet の報告・連絡（`merged`・`verdict`・`wait`・`notice`）・返せなくなった答え・intel に回せなかった気づき（節「相談・アイデアを intel に回す」））。手順8の止まったタスクの見回しからは、割り振ったもの（どの fleet に渡したか）・案として聞いたもの（Epic の案・引き継ぎの問い）・人が決めなかったもの（答え無し・拒まれた・空き待ち）と、patrol の未採用の下書きの数を足す。費用は手順8の `panes.ts fleets --session` の各行の `totalUsd` と、hq 自身の `node harness/scripts/agent.ts usage` をまとめる。

## 相談・アイデアを intel に回す

hq に流れてきた相談・アイデア（fleet からも人からも）を、hq が自分で抱えずに intel（[intel](../intel/SKILL.md)。Orca の本体のタブで待つ）に回す（#396）。

- **分け方**：
  - 人に上げる（今までどおり ship → fleet → hq → 人）：今の進め方を決めるもの。fleet の `question`（`ask`）、`agent:plan-review` で進めてよいか、着手宣言の引き継ぎ、`escalation`、テーマの承認など。
  - intel に回す：今すぐの判断が要らないもの。今の Issue の範囲の外の仕組みの問題・運用で見つけたずれ・止まり方・改善案・Issue の種。
  - 1つの相談に両方が混ざるときは分け、判断の要る部分は hq が人に聞き、残りを intel に回す。迷ったら人に上げる側にする（判断の要るものを intel に流して止めないため）。
- **回し方**：`SendMessage` の `to: intel` で送る。本文は出どころ（人・fleet のテーマ・Issue 番号）・要点・根拠（Issue・PR・コメントの番号、ファイル）を短く。返事を待たない（intel は「受け取った」と返すだけ）。hq は回したものを自分で抱えない（Issue にしない・下書きにしない）。
- **人への案内**：人が hq に相談・アイデアを言い、それが intel に回すものなら、intel に回したうえで「intel に回しました。次からは intel のタブに直接送ってください」と1行で返す。人の判断が要る部分があれば、その部分は今までどおり hq が AskUserQuestion で扱う。
- **intel のタブの起こし方**：手順1で本体を確かめた後に、`ListAgents` で `intel` の名前のセッションを探す。
  - 既にいる（ほかの hq やこれまでの起動で残っている）ときは起こさずにそれを使い、タブを二重に作らない。
  - 無ければ、`.claude/skills/intel/SKILL.md` が本体にあるときだけ、本体（main の checkout）で起こす。置き場所は手順6のペインの右（真ん中の列を `ORCA terminal split --direction vertical` で分けた handle。#402）で、分けられないときだけ `ORCA terminal create --worktree path:<本体の絶対パス> --title intel --json` でタブを作る。その handle に `ORCA terminal send --terminal <新しい handle> --text "claude --permission-mode auto --name intel /intel" --enter`（`--command` に空白を含めて渡さない。fleet の skill の手順3と同じ）。intel は何にも触らない役なので、本体で動かしてよい。
  - 起こした後は、画面が auto mode であることを確かめる。bypass なら `ORCA terminal close --terminal <intel の handle>` で閉じ（閉じる handle が hq 自身の端末でないことを確かめる。手順6の「自分の端末を閉じない」）、「intel がいない」の扱いにする（intel は本体で動き、印 `.agent-harness-workspace` が無いので hook で書き換えを止められないため）。
  - intel の skill が無い、起こせない（Orca のコマンドが失敗した）ときは、起こし直さずに「intel がいない」の扱いにする。
- **intel がいないとき**：`ListAgents` に intel が無い、または `SendMessage` が失敗したら、送らずに今までどおり手順12の一覧に「intel に回せなかった気づき」として書く。

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
