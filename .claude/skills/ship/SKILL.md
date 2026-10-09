---
name: ship
description: 人が付き添うセッションで、Issue 番号を受け取り、plan → implement → judge → fix（必要なら sync）の skill をつないで、人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを一覧にする。「#番号 を進めて」「#番号 を ship して」「〜を Issue にして進めて」と頼まれたときに使う。
---

# ship（Issue を一続きに進める）

plan・implement・judge・fix・sync の各 skill（[.claude/skills/](../)）を、Issue の状態に応じてつなぐ手順。各段階の中身は各 skill に従い、ここに写さない。

## 入力

- Issue 番号
- Issue がまだ無い依頼（「〜を Issue にして進めて」）なら、Issue Form（`.github/ISSUE_TEMPLATE/agent-task.yml`）の見出しと、タイトルの書式（`harness/lib/title.ts` の `parseTitle`、Conventional Commits）に合わせ、[docs/operations.md](../../../docs/operations.md) の「Issue の書き方」どおり1つの変更に絞って（AC に skill や docs の文のテストを入れない）`gh issue create` で作り、その番号で手順1から進める。人が「作るだけ」と言わない限り、作った Issue は同じセッションで plan まで進める
- Issue の状態：ラベル（`agent:plan-ok`・`agent:plan-review`・`epic`・`agent:waiting`・`agent:blocked`・`agent:hold`）と、`gh issue view <番号> --comments` の本文・コメント
- 計画ゲートの記録：`node harness/scripts/agent.ts show-plan <番号>`
- Issue を Closes する開いた PR：`gh issue view <番号> --json closedByPullRequestsReferences`。Stacked PR の下の層は本文が `Refs #N` で Closes にならないので、`gh pr list --state open --json number,body,baseRefName` から本文で `Refs #<番号>` を探す

## 手順

1. 状態を読み、次の段階を決める。PR があれば手順4から、計画ゲートを通った計画があれば手順3から始める。Merge 済みの PR があれば、下の「Merge 済みで呼び直されたとき」だけを行う。
   - Merge 済みで呼び直されたとき（Epic #281 の決定。ship は Issue と PR の Close に責任を持つ）：手順7の `worktree-remove` で worktree を片付け（消すのは Merge 済みの PR の head のブランチの worktree だけ。既に無ければ消さない。消す前に `git -C <worktree> status --porcelain` と未 push の commit（`git -C <worktree> log @{u}..`）を確かめ、残っていれば消さずに人に返す。`worktree-remove` は未 commit の変更があっても消すため）、Issue が Close されたか（`gh issue view <番号> --json state`）を見届ける。Validation Requirements のうちセッションで確かめられるもの（main で `npm run check` を流すなど、コマンドを流すだけのもの）は ship が行って結果を返し、人にしかできないものだけを人がすることの項目にする。何度呼ばれても同じ結果になるようにする。コードは変えず、着手宣言もしない。
   - ハーネスが更新されたとき：各段階の `claim` の前に、`node harness/scripts/agent.ts harness-drift`（か `claim` の標準エラーの一言）で、このセッションの読み込みが古いかを見る。古ければ進めている段階を終えてから `release <番号>` し、fleet の節「ハーネスが更新されたときの交代」と同じ手順で交代する（渡す1行は `/fleet <自分の Issue 番号>`。Epic の子課題なら `/fleet --epic <Epic番号> <自分の Issue 番号>`）。judge は古いセッションで始めない（`claim --stage judge` も止まる）。
   - 着手宣言：Issue に手を付ける最初に、その段階の skill の手順どおり `claim <番号> --manual --stage <段階>` で宣言する（計画・批評の前も）。宣言にはこのセッションの ID が入り、ほかのセッションとダッシュボードに段階が見える。ほかのセッションの宣言があれば `claim` は止まるので、引き継ぐかを AskUserQuestion で人に聞く（引き継ぐのは人が決めたときだけ `--takeover`）。
   - 最初の宣言が持ち主。`claim` が「先に宣言したセッションがある」で止まったら（同時に宣言して後の側になった。自分の宣言は取り下げ済み）、その Issue は進めず、作業を始めずに、手順10の一覧に「#番号 は session …（エラーに出た短い ID）が着手中」と書いて終える。引き継ぐかは人が決める（この場では聞かない）。
   - 人の判断待ちで止めてセッションを終えるときは `node harness/scripts/agent.ts release <番号>` で解除する（宣言が残ると、ほかのセッションを待たせ、期限切れとして報告される）。`post-plan` はゲートを通らない見込みなら自分で解除する。`/clear` などでセッション ID が変わったら、前のセッションの宣言を1件ずつ聞かずに、「前のセッション（session <短い ID>）の宣言 #…（N 件）をこのセッションに引き継ぐか」を AskUserQuestion の1問でまとめて聞き、引き継ぐなら全部を `claim --takeover` で出し直す（拒まれたら出し直さない）。
   - `claim` が Assignee で止まった（`harness.config.json` の `requireAssignee` が有効で、誰もアサインされていない・ほかの人・2人以上）：自分をアサインせずに進めず、人に返す（質問にはせず、止まった理由を手順10の一覧に書いて終える。アサインするかは人が決める。[docs/operations.md](../../../docs/operations.md) の担当）。途中の段階の確かめ（`critic-input`・`post-plan`・`worktree`・`ensure-claim`）で止まったときも同じ。
   - `agent:hold`・`agent:blocked`・`agent:waiting` が付いている：進めずに人に返す。ただし Stacked PR の上の層が `gh stack link` の前に付いた orphan-base（App の `kind=orphan-base`）は例外で、[gh-stack](../gh-stack/SKILL.md) の skill で組めば App が戻す。
   - `epic`：App の記録（`kind=epic-split`）の子課題を、依存の順に1つずつこの手順で進める。1つが人の Merge 待ちか人の判断待ちになったら、そこで人に返す（次の子課題は、その Merge の後）。
2. 計画が無ければ plan の skill で計画を書いて投稿する。Planner の質問（`openQuestions`・`needsHumanReasons`）は plan の skill の手順3どおり投稿の前に AskUserQuestion で聞いて計画に書き込むので、投稿の後に申告が残るのは答えの無かったものだけになる（fleet の入れ子の方式で動く ship は聞かずに fleet に返す。下の「サブエージェントの ship として動くとき」）。批評の止める条件や `drop` に当たったら、plan の skill どおり「進める／直す／やめる」を AskUserQuestion で聞く。App の計画ゲートの結果が付くのを待つ（`gh issue view <番号> --json labels`）。
   - `agent:plan-ok`：次へ。委任承認（ダッシュボードの `agent:delegate-plan` か `agent:delegate-merge`）の間は、`post-plan` が通らない見込みとして宣言を解除していても App が `agent:plan-ok` を付けることがある。そのときも implement の `claim --stage implement` で宣言し直す。
   - `agent:plan-review`（critical、ガードレールに触れる、人の判断が要る など）：宣言が残っていれば（`post-plan` の出力の `claim` が `plan-gate`）先に `release <番号>` で解除する。理由を示し、進めてよいかを AskUserQuestion で聞く（選択肢は、進める・止める、止めた理由が計画で直せる（ゲートの停止）なら計画を直して出し直す（plan の skill の出し直しの扱い）も）。人が進めてよいと答えれば、plan の skill の手順10どおり人の「進める」を進める記録（`agent-decision` の `proceed`、`post-decision`）で残し、App の `plan-proceed` の記録を確かめてから次へ（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の規則どおり。implement の `claim --stage implement` で宣言し直す。記録が `ineligible` なら理由を手順10の一覧に書き、実装は続ける）。答えなければ人に返す。
     - Planner の申告（理由コード `needs-decision`）なら、plan の skill の手順9どおり人の答えを `agent-decision` で記録し（`post-decision`）、App の `plan-decision` の結果を待つ。`enforce` で通れば次へ、`shadow` なら人が「進める」と言えば、plan の skill の手順10の進める記録を出してから次へ（ラベルを外すよう人に頼まない）。答えで計画が変わるなら、App が判定し直した後（`agent:plan-ok` か `gate` の停止）に計画を出し直す。
   - `epic`：手順1の `epic` に戻る。
3. implement の skill で実装し、Draft PR を出す。worktree は消さずに続ける。
4. judge の skill で判定する。現在の head にコラボレーターのレビューがあれば、先に fix の skill をする。
5. 判定にブロッキング指摘があれば（App の `kind=fix-request`）、fix の skill で直し、判定をやり直す。PR が main と衝突している、または main への追従が要るときは sync の skill をする。修正の上限（`agent:blocked`、理由コード `fix-limit`）に達したら人に返す。
6. 合格して Ready になったら、Merge の経路を確かめる。
   - 自動 Merge：App が auto-merge を付けたこと（`gh pr view <PR番号> --json autoMergeRequest` が null でない）。
   - Human Merge：App のコメント（本文に `kind=human-review`、作成者が App）が PR に付いたこと（[docs/operations.md](../../../docs/operations.md) の「Human Merge の依頼」）。
   - 数分待ってもどちらも無ければ、App の記録（`kind=acceptance` の `autoEligible` と `reasons`）を読んで人に返す。
   - Stacked PR の層はいつも Human Merge（auto-merge も従来の Merge API も使えない）。
7. 続けて使わなければ `node harness/scripts/agent.ts worktree-remove claude/issue-<番号>-<短い名前>` で worktree を消す。
8. ラベル（`priority:*`・`area:*`）は、まず Jev に任せる（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。扱った Issue（Epic なら親と子課題）に、App の名義（`appSlug` の App が書いたコメント）の `kind=label-triage` の記録があり、その `notApplied`（下限未満で付けなかったもの）がまだ足りなければ、本文と Jev の提案を見て決めて付け、付けたラベルと理由を Issue のコメントに残す。記録が無ければ付けない。人や App が付けたラベル・`type:*`・違反は変えない。不足や違反を手順10の一覧に書かず、人にも聞かない。
9. 振り分け：途中の段階で、拒否された操作・人に返す条件・App の拒否（ゲートの停止・受け付けの拒否）・人の訂正・手順に無い回避策が起きたら、その場で `node harness/scripts/agent.ts incident add --kind <種類> --what <起きたこと> --target <#番号|PR #番号> --workaround <回避策>` で記録しておく（種類は deny・return-to-human・app-reject・human-correction・workaround。記録はリポジトリの外のファイルで、GitHub には書かない。[docs/operations.md](../../../docs/operations.md) の「問題の記録と振り分け」）。人がすることの一覧の前に `node harness/scripts/agent.ts incident list` を読み（`/clear` でセッションが分かれたら `--session` を重ねて前の記録も読む）、1件ずつ次に振り分ける。
   - ハーネスの不具合・手順の抜け → Issue の候補。`gh issue list --state open --search "<要点の語>"` で開いた Issue を探し、同じものがあれば新しく立てず、その Issue へのコメントの案にする。無ければ `node harness/scripts/agent.ts incident render-issue <id>... --title <題>` で Issue Form の形の下書きを作り、本文を scratchpad のファイルに書く。
   - このパソコンの環境（ツールの版・認証・パスなど）→ docs の候補か、何もしない。
   - 一度きりのミス → 記録だけ（候補にしない）。
   - 起票・コメントは人が選んだものだけ。自動で起票しない。人が選んで起票した Issue のラベル（`priority:*`・`area:*`）は手順8と同じく Jev に任せる。
10. 人に**人がすること**の一覧を出す。
   - Merge：Human Merge なら PR を確認して Merge する。自動 Merge なら何もしない（止めたければ `agent:hold`）。Stacked PR は、スタックの全部の層が Ready になってから、人が GitHub の画面でスタックを Merge する（Draft の層があると Merge できない）。
   - 例外ラベル：`test:exempt` は自動 Merge の対象の PR で `agent/tests` が failure のときだけ（Human Merge の PR では付けず、依頼のコメントに載ったテストの変更を Merge の前に確かめる、を「Merge」の項に書く）。`review:exempt` は付けるかの判断。どちらも、その理由を書いた場所（Issue か PR のコメント）
   - `node harness/scripts/setup.ts` の実行が要る変更か（ラベル・Ruleset・Environment・App の設定を変えた）
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - 宣言で負けて進めなかった Issue：「#番号 は session … が着手中」（引き継ぐなら人が決めて `--takeover`）
   - Assignee で止まった Issue：「#番号 は Assignee が自分1人ではない（理由）」（アサインは人が決める）
   - 改善の候補：手順9の Issue の候補（題と下書きの本文のファイルのパス）と、開いた Issue へのコメントの案。docs の候補もここに並べる。起票・コメントは人が選んだものだけ（自動で起票しない）。候補が無ければ「改善の候補はありません」と書く

## サブエージェントの ship として動くとき

fleet の入れ子の方式（[.claude/skills/fleet/SKILL.md](../fleet/SKILL.md) の「入れ子の方式」）で、fleet からサブエージェントとして呼ばれたときは、手順1〜10を次のとおり変えて進める。人とは話さず、fleet に返す。

- 1回の呼び出しでは、fleet から渡された段階だけ（1段階）を行う。段階は `plan`（計画ゲートの結果まで）・`implement`（Draft PR まで）・`judge`・`fix`（判定の受け付けと、合格なら手順6まで）・`sync`・`merged`（手順1の「Merge 済みで呼び直されたとき」。Close の見届けまで）。次の段階は fleet が `fleet-status` の表で決めて、新しいサブエージェントの ship を呼ぶので、続きの段階に進まない。
- 始めるときは、会話ではなく、渡された引き継ぎのファイル・Issue と計画コメント（`show-plan`）・PR とその記録を読む。足りないもの・食い違い（例：`implement` を渡されたのに計画ゲートを通っていない）は推測で埋めず、材料を読み直すか、`status` を `return-to-human` にして返す。
- 段階の終わりに、scratchpad の `handoff-<番号>-<段階>.md` に `agent-handoff` ブロック（[docs/formats.md](../../../docs/formats.md) の「引き継ぎ（agent-handoff）」）を書き、`node harness/scripts/agent.ts check <ファイル>` で確かめてから、ファイルのパスとブロックを返す本文に入れる。人に聞くこと・人がすることの項目・待つ理由はブロックに入れず、本文に書く。
- 最初に、自分が Agent ツールを使えるかを確かめる。使えなければ何もせず（着手宣言もしない）「入れ子不可」と返す。
- 各 skill が AskUserQuestion で人に聞くところ（plan-critic の「進める／直す／やめる」、`agent:plan-review` で進めてよいか、引き継ぎ（`--takeover`）、計画の `files` の外の変更など）では聞かずに止まり、Issue 番号・段階・聞きたいこと・選択肢（おすすめを先頭）を返す。宣言の扱いは、人の判断待ちで止めるときと同じ（必要なら `release <番号>`）。fleet から答えを渡されて呼び直されたら、その答えを人の答えとして続きから進める。
- plan の投稿の前の質問（plan の skill の手順3の「投稿の前に人に聞く」。計画ブロックに `openQuestions` か `needsHumanReasons` がある）でも、聞かずに止まる。計画を投稿せず、批評（plan の手順5）にも進まずに、Issue 番号・段階（投稿の前の質問）・質問と選択肢（おすすめを先頭）・書きかけの計画のファイルのパス（scratchpad）を fleet に返す。着手宣言は `plan` のまま残す（解除しない。答えの無いまま fleet が終えるときは fleet が `release <番号>` する）。批評の `revise` で直した計画に新しい質問が出たときも、同じように止まって fleet に返す。
- 投稿の前の質問への答えを渡されて呼び直されたら、先に `claim <番号> --manual --stage plan` で宣言を確かめ直し（fleet が `release` した後なら宣言し直す）、渡されたパスの計画に、答えを人の答えとして plan の skill の手順3どおり書き込み（節「人の決定（投稿の前に聞いたこと）」）、解消したものを `openQuestions`・`needsHumanReasons` から除いてから、批評（plan の手順5）と投稿（plan の手順8）に進む。「答え無し」（人が拒んだ・答えなかった）の質問は申告に残して投稿する（投稿の後は plan の手順9の経路。答えが無いので `post-decision` はしない）。書きかけの計画のファイルが無ければ plan の手順2から書き直し、渡された答えをそのまま書き込む（同じ質問を fleet に返し直さない）。
- implement の前と sync の前に、fleet から渡された Issue 番号の集合と `--max` で `node harness/scripts/agent.ts fleet-status [--max <n>] <番号>...` を読み、自分の行が「待つ」なら進めずに、その理由を返す（自分の番号だけで読むと、ほかの Issue との重なり・PR 同士の衝突・本数が数えられない）。
- `claim <番号> --manual --stage implement` が領域の上限（`areaConcurrency`）で止まったら、`--force`・`--fleet` を付けずに「待つ（領域の上限）」として返す（`--fleet` で宣言し直すかは fleet が決める）。
- ハーネスが更新されたとき：ship は fleet と同じセッション ID なので、自分では交代しない。段階を始める前に `harness-drift` で古いと分かったら、進めずに「待つ（読み込みが古い）」として fleet に返す（宣言の扱いは人の判断待ちで止めるときと同じ。必要なら `release <番号>`）。交代は fleet が行う。
- Merge 済みの PR で呼び直されたら、手順1の「Merge 済みで呼び直されたとき」を行い、Close の見届けの結果を返す。
- 手順9の振り分けはこの ship の記録（`incident list`）で行い、手順10の一覧は人に出さず、その項目（Merge・例外ラベル・setup の要否・Merge 後の確かめ・改善の候補）を返す。fleet がまとめて人に出す。
- 返すもの：Issue 番号、PR 番号（あれば）、引き継ぎのファイルのパス、終わった状態（人の Merge 待ち・人の判断待ち・待つ・入れ子不可・人に返す条件に当たった・Merge 後の見届け済み（Close 済み）・Close されていない（理由。`Closes` の無い PR など））、人に聞くこと、人がすることの項目、待つ理由。

## 実装のモデル（fleet から起こされた ship）

fleet から起こされた ship（節「サブエージェントの ship として動くとき」の入れ子のサブエージェントと、fleet が Orca の worker として起こした ship（fleet の `--spec` に、前置きの `ask` で fleet に聞き `worker_done` を送る指示がある））は、コードを書く部分だけを、`node harness/scripts/agent.ts show-plan <番号>` の出力の `modelRouting.use` のモデルのサブエージェントに任せる（Epic #446、Issue #139）。`use` は、`jev.modelRouting` が `enforce` で、計画ゲートを通った計画に Jev の勧めがあれば勧め、それ以外（`shadow`・`off`・勧めの記録なし）は `implementModel`（`harness.config.json` の `fleet.implementModel`。既定 `sonnet`、`opus` に戻せる）。implement だけでなく fix・sync の段階も同じ `show-plan` の結果を使う。

- 見分け方：`fleet.shipMode` の値だけでは決めない。人が直接呼んだ ship は、`shipMode` が `worker` でも単独の ship として扱う。
- `show-plan` が止まる計画（`agent:plan-review` から人が進めると決めた計画）は、`node harness/scripts/panes.ts config` の `implementModel`（`fleet.implementModel`）を使う。
- 任せる部分：implement の手順4・5（計画の `files` の範囲で書き、`npm run check` を通す）、fix のコードを直す部分、sync の衝突を解く部分。Agent ツールで `subagent_type` を `general-purpose`、`model` を上で決めたモデルにして呼ぶ。
- 渡すもの：計画コメントの本文、Issue の AC、worktree の絶対パス、test-designer が先に書いたテストのパス（fix なら直す指摘、sync なら衝突のファイル）。
- test-designer が先に書いたテストを合格の基準にする。サブエージェントはテストを弱めない・消さない（`agent/tests` の検査は変えない）。
- 指示に次の文を入れる：「計画に無い設計の判断（新しいファイル・公開の形の変更・計画の `files` の外の変更）が要るなら、書かずに止まり、理由を返す。AskUserQuestion は使わない。commit・push はしない」。
- 任せたときは、implement の手順4の「範囲外の変更が要るなら AskUserQuestion で人に聞く」の代わりに、この節の「止まって返す」に従う。
- サブエージェントが止まって理由を返したら、ship は自分で書き足さずに `node harness/scripts/agent.ts claim <番号> --manual --stage plan` で段階を `plan` に戻し、理由を踏まえて plan の skill で計画を出し直す（計画ゲートを通し直す）。
- commit・push・PR・判定は ship が行う（implement の手順6から、fix・sync の push からは今のまま）。
- 変えないもの：plan・plan-critic・judge の担当（reviewer・risk-agent・合体版のレビューの担当）・test-designer・fleet・hq のモデル。
- 人が付き添う単独の ship（fleet の交互の方式を含む）はモデルを切り替えず、本体のセッションが自分で書く。
- PR 本文（implement の手順10）に `実装のモデル: <model>` の1行を書く（任せたなら使ったモデル、単独の ship なら本体のモデル）。

## 終わりの状態

- 次のどちらか。
  - 人の Merge 待ち：Ready の PR があり、App が auto-merge を付けたか、`kind=human-review` のコメントを付けた。
  - 人の判断待ち：どの段階の、何を決めてほしいかを AskUserQuestion で聞いた（拒まれた・答えが無いときは文章で示した）。
- 人がすることの一覧を出した。
- 改善の候補を示した（無ければ無いと書いた）。

## 人に返す条件

途中で人に返すとき（下のどれに当たったときも）も、手順9の振り分けをして改善の候補を示してから返す。

- Issue に `agent:hold`・`agent:blocked`・`agent:waiting` が付いている
- `requireAssignee` が有効で、Issue（PR の段階なら PR が Close する Issue）の Assignee が自分1人でない（自分をアサインしない）
- 計画の批評が止める条件に当たった、または `drop`（「進める／直す／やめる」を AskUserQuestion で聞く）
- 計画ゲートで止まり（`agent:plan-review`）、人が進めてよいと言わない
- 判定の不合格が修正の上限を超えた（`fix-limit`）
- 両方の意図を残して解消できない衝突がある
- Ready になっても、App が auto-merge も `kind=human-review` も付けない
- 各 skill の「人に返す条件」に当たった
- 操作が deny などで拒否された（別の方法で試さない）
- このセッションの読み込みが古いのに judge に当たった（`claim --stage judge` が止まった）、または交代を拒まれた（fleet の節「ハーネスが更新されたときの交代」）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge`・auto mode のラベル（既定 `agent:auto-mode`。名前は `harness.config.json` の `autoMode.label`）と `*:exempt` のラベルの付け外し
