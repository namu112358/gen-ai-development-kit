---
name: fleet
description: 人が付き添うセッションで、複数の Issue を選び、ship を Issue ごとにサブエージェントで並行に動かして（入れ子にできなければ ship の各段階を交互に進めて）、全部を人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを1つの一覧にする。「複数の Issue をまとめて進めて」「fleet で進めて」と頼まれたときに使う。
---

# fleet（複数の Issue を並行して進める）

ship（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）を複数の Issue について進める手順。各段階の中身は ship と各 skill に従い、ここに写さない。進め方は2つあり、`fleet-status` の表の末尾の「進め方」の行（`harness.config.json` の `fleet.nesting`）で決まる。

- **入れ子（orca、既定）**：サブエージェントの中でさらにサブエージェントを呼べる環境（Orca）で、Issue ごとに ship をサブエージェントとして並行に動かす（fleet > ship > plan-critic・test-designer・reviewer・risk-agent）。1つの Issue のコードの読み書きは、その ship のコンテキストに閉じる。手順は「入れ子の方式」の節。
- **交互（flat）**：1つのセッションの中で、ship の段階を Issue ごとに交互に進める。ship の中でサブエージェントを呼ぶので、ship そのものをサブエージェントにしない。手順は「手順」の節の2〜5。入れ子の方式でも、ship が「入れ子不可」を返したらこちらに切り替える。

`harness.config.json` の `fleet.shipMode` が `worker`（既定は `subagent`）で、かつ Orca があるときだけ、ship をサブエージェントでなく Orca の worker（独立したセッション）で動かす。手順は節「Orca の worker で ship を動かすとき」。Orca が無い・動かないときは、上の2つのどちらかで進める。

hq に Orca の worker として起こされたとき（プロンプトに orchestration の注入の前置きがある）は、節「Orca の worker として動くとき」にも従う。それ以外のときは、その節を読まない。

## 入力

- 対象：Issue 番号の一覧（任意）。無ければ `agent:ready`・`agent:plan-ok`・`agent:plan-review` の開いた Issue と、`agent:*` の無い、コラボレーター（OWNER・MEMBER・COLLABORATOR）か App（Epic の子課題など）が立てた開いた Issue（作ったまま計画に進んでいないもの）から選ぶ（`harness/lib/fleet.ts` の `fleetTargets`）
- 複数の Issue を作る依頼（「〜を Issue にして進めて」）なら、ship の入力と同じ書き方で作り、作った番号を対象にして、人が「作るだけ」と言わない限り同じセッションで plan から fleet を続ける
- 受け持つ Epic（任意）：`--epic <Epic番号>`（`/fleet --epic <Epic番号> <番号…>`。hq がテーマの fleet を起こすときも、交代の1行もこの形で渡す）。無ければ、対象の Issue の本文の子課題の印（`harness/lib/epic.ts` の `parseChildMarker`）の親が全部同じならその Epic にする。印の親が複数・無い Issue があれば、Epic は無いとして扱う（推測しない）。fleet は受け持つ Epic の終了に責任を持つ（節「待つ間の読み直し」の 7）
- 本数（任意）：衝突しない範囲で本数を制限せずに進める。本数を絞りたいときだけ `--max <n>` を渡す
- 状態の表：`node harness/scripts/agent.ts fleet-status [--max <n>] [<Issue 番号>...]` の出力（Issue・PR ごとの段階、次にやること、選ぶか・待つ理由、重なり）

## 選び方

- `harness.config.json` の `requireAssignee` が有効なら、Assignee が自分（今の GitHub のユーザー）1人でない Issue（誰もいない・ほかの人・2人以上）は選ばず、表の「選択」に理由が出る（PR の段階も Issue の Assignee で見る）。アサインは人が決め、fleet も ship も自分からはアサインしない。外れた Issue は最後の一覧に理由と一緒に書く。
- 領域の上限（`areaConcurrency`）は fleet では見ない。
- PR が無い段階の Issue は、既に選んだ Issue・PR 段階・実装中の Issue と計画の files が重なれば待つ。重なりの相手にする着手宣言は、ほかのセッションの解除されていない宣言と、このセッションの実装中（段階 `implement`）の宣言だけ。このセッションのほかの段階（plan・plan-gate など）の宣言どうしで重なれば、並べた順の先の側を選び、後の側が待つ（入れ子の方式では ship が全部このセッションの ID で宣言するため）。
- 既に選んだ Issue のうち段階が `plan-review`（人の判断待ち）のものは、ほかの Issue の重なりの相手にしない（今は進まないので、進められる Issue を待たせない）。`plan-review` の Issue 自身は、PR 段階・実装中の Issue と重なれば待つ。人が進めると決めた後は、手順3で読み直した表で改めて重なりを判定し、相手が既に実装中（`implement` の宣言）ならその Issue が待つ。
- `harness.config.json` の `fleet.sharedFiles`（既定：決定ログ・記録用の docs・各 README.md）だけで重なる組は待たせない（表の「重なり」列に「共有ファイルのみ（並行可）」と出る）。
- 両方に PR がある組は、`fleet-status` が PR の head を fetch して `git merge-tree` で実際に試し、衝突する組だけ、並べた順の後の側が待つ。衝突しなければ、同じファイルを変えていても並行して進める。
- `git merge-tree --write-tree` が使えない環境（git 2.38 未満）や fetch に失敗したときは、PR 同士が全部「衝突」扱いになる（表のメモに「試せなかったため衝突ありとして扱う」と出る）。

## 手順

1. `node harness/scripts/agent.ts fleet-status`（対象を指定されたら番号も、本数を絞るなら `--max <n>` も渡す）で表を出し、「選ぶ」の Issue を控える。以降は同じ番号を渡して表を読み直す。選べる Issue が無ければ、待つ理由を添えて人に返す。表の末尾の「進め方」の行が入れ子（orca）なら、この手順1の宣言の扱いを守ったまま「入れ子の方式」の節で進め、交互（flat）なら手順2〜5で進める。ただし `node harness/scripts/panes.ts config` の `shipMode` が `worker` なら、先に節「Orca の worker で ship を動かすとき」の 1 で Orca の有無を確かめ、あればその節で進める。`fleet-status` が `harness.config.json` の `fleet` の誤りで止まったら、人に返す（方式を推測で選ばない）。
   - このセッションの着手宣言（宣言の session が今のセッションの ID と同じ）は選ばれ、メモに段階が出る。PR の無い段階は Issue の宣言を、PR の段階は PR の宣言（`claim <PR番号> --stage judge|fix|sync`）を見る（メモには「PR の着手宣言」と出る）。「着手宣言あり」で選ばれない Issue が止まった前のセッションの途中のもの（`/clear` で ID が変わった場合を含む）なら、1件ずつ聞かずに、前のセッションごとに「前のセッション（session <短い ID>）の宣言 #…（N 件）をこのセッションに引き継ぐか」を AskUserQuestion の1問でまとめて聞く（おすすめは引き継ぐ。Orca の worker のときは hq に `ask` の1問）。引き継ぐなら全部を `node harness/scripts/agent.ts claim <番号> --manual --takeover` で出し直して読み直す（PR の段階なら `claim <PR番号> --manual --stage judge|fix|sync --takeover`）。拒まれたら出し直さない。
   - Issue に手を付ける最初に、ship と同じく `claim <番号> --manual --stage <段階>` で宣言する。人の判断待ちで止めてセッションを終えるときは `release <番号>` で解除する。
   - `claim` が「先に宣言したセッションがある」で止まったら（同時に宣言して後の側になった。自分の宣言は取り下げ済み）、その Issue を飛ばして次の Issue へ進み、最後の一覧に「#番号 は session … が着手中」と載せる（引き継ぐかは人が決める）。
   - 着手宣言（`claim <番号> --manual`）が領域の上限で止まったら、`--force` を付けて宣言する（fleet は領域の上限を見ないため）。
2. 「選ぶ」の Issue ごとに（選択が「待つ」の行は、次にやること（fix・judge など）が出ていても進めない）、表の「次にやること」の段階を ship と同じ判断（ship の手順2〜6）で1つ進める。
   - plan：plan の skill。批評（plan-critic）は Issue ごとに並行して呼んでよい。Planner の質問（`openQuestions`・`needsHumanReasons`）は plan の skill の手順3どおり投稿の前に AskUserQuestion で聞く（複数の Issue の質問を1回にまとめてよい。1回に4問まで）。入れ子の方式では ship が投稿せずに質問を返すので、「入れ子の方式」の手順2でまとめて聞き、答えを渡して ship を呼び直す。計画ゲートが `agent:plan-review` で止めた Issue は、ship の手順2と同じく、宣言が残っていれば `release <番号>` で解除してから、進めてよいかを聞く（手順9でまとめて聞いてよい）。Planner の申告で止まったら、ship の手順2どおり人の答えを `post-decision` で記録する。人が「進める」と答えたら、plan の skill の手順10どおり、その言葉を進める記録（`agent-decision` の `proceed`、`post-decision`）で残してから implement に進める（入れ子の方式では、答えを渡して呼び直した ship が記録する）。
   - implement：implement の skill。worktree は Issue ごとに分ける。test-designer・実装は並行してよい。
   - judge：judge の skill。Reviewer・Risk Agent は Issue ごとに並行して呼んでよい。
   - fix：fix の skill。
   - sync：sync の skill。
   - 「—」（待つ）：計画ゲート・判定の受け付け・App の Merge 経路を待つ。ほかの Issue を先に進める。
3. 段階を1つ進めるたびに、手順1の `node harness/scripts/agent.ts fleet-status` を読み直して、次にやることを決める。セッションの記憶に頼らない（止まっても同じ手順で続きから再開できる）。
   - 計画の後に「触るファイルが重なるため待つ」になった Issue は、実装に進めない（先に選んだほうの Merge の後に読み直す）。
   - PR 同士が衝突して待つ Issue は、先の側が Merge された後に sync の skill で main を取り込んでから進める。
   - `--max` の本数で待つ Issue は、ほかが Merge されるまで進めない。
4. Merge 済みの Issue が出たら、次にやることが sync になった残りの PR に sync の skill をする（判定が引き継がれたかを確かめ、変わっていれば判定し直す）。
5. 「選ぶ」の Issue が全部、人の Merge 待ち（Ready・人の Merge 待ち、自動 Merge 待ち）か人の判断待ち（plan-review、止まる印あり、各 skill の人に返す条件）になるまで、手順2〜4を繰り返す。その後、手順6〜9で一覧を出し、人の判断待ちだけが残ったのでなければ、終わらずに節「待つ間の読み直し」へ進む。
6. ラベル（`priority:*`・`area:*`）は、ship の手順8と同じく、まず Jev に任せ、App の名義の `kind=label-triage` の記録の `notApplied` がまだ足りなければ、本文と Jev の提案を見て決めて付け、付けたラベルと理由を Issue のコメントに残す。記録が無ければ付けない。人や App が付けたラベル・`type:*`・違反は変えない。不足や違反を手順9の一覧に書かず、人にも聞かない。
7. `node harness/scripts/agent.ts usage` で、このセッションのトークン数と推定料金を読む（入れ子の方式の ship とその中の担当の記録も、このセッションの `subagents/` に置かれるので集計に入る）。
8. 振り分け：ship の手順9と同じ振り分けを、Issue をまたいで1回行う（`node harness/scripts/agent.ts incident list` で記録を読み、入れ子の方式の ship は fleet と同じセッション ID なので同じ記録に入る。Issue の候補は `gh issue list --state open --search "<要点の語>"` で開いた Issue と照らし、無ければ `node harness/scripts/agent.ts incident render-issue <id>... --title <題>` で下書きを作る）。複数の Issue で同じ問題が出たら1つの候補にまとめる。起票・コメントは人が選んだものだけで、自動で起票しない。人が選んで起票した Issue のラベルは手順6と同じく Jev に任せる。
9. 人に**人がすること**の一覧を1つにまとめて出す（Issue・PR ごとに ship の手順10と同じ項目）。
   - Merge：Human Merge の PR（Merge の順番に意味があれば順番も）。自動 Merge なら何もしない（止めたければ `agent:hold`）
   - 例外ラベル：`test:exempt` は自動 Merge の対象の PR で `agent/tests` が failure のときだけ（Human Merge の PR では付けず、依頼のコメントに載ったテストの変更を Merge の前に確かめる、を「Merge」の項に書く）。`review:exempt` は付けるかの判断。どちらも、その理由を書いた場所
   - `node harness/scripts/setup.ts` の実行が要る変更か
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - 人の判断待ち：どの Issue の、どの段階の、何を決めてほしいか。一覧を出した後に AskUserQuestion でまとめて聞く（1回に4問まで。聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。入れ子の方式の投稿の前の質問で答えが無いまま終える Issue は、`release <番号>` で解除してから「計画は投稿していない」と書く
   - 待たせた Issue と理由（重なり・PR 同士の衝突・`--max` の本数）
   - 宣言で負けて飛ばした Issue：「#番号 は session … が着手中」
   - 費用：進めた本数と、手順7のトークン数・推定料金
   - 改善の候補：手順8の Issue の候補（題と下書きの本文のファイルのパス）と、開いた Issue へのコメントの案・docs の候補。起票・コメントは人が選んだものだけ（自動で起票しない）。候補が無ければ「改善の候補はありません」と書く

## 入れ子の方式（orca）

表の「進め方」の行が入れ子（orca）のときの、手順2〜5の代わり。手順1・6〜8と「選び方」はそのまま使う。

1. 表の「選ぶ」の Issue ごとに、ship の skill を general-purpose のサブエージェントで呼ぶ。同時に動かすのは、表の「同時に動かす ship は <n> まで」の数まで（`--max` があれば `--max`、無ければ `fleet.maxParallelShips`）。残りは、1つ返るたびに表を読み直してから呼ぶ。
   - 渡すもの：Issue 番号、「サブエージェントの ship として動く（ship の skill の「サブエージェントの ship として動くとき」の節に従う）」こと、fleet が `fleet-status` に渡した Issue 番号の集合と `--max`（ship が同じ引数で表を読むため）、呼び直すときは人の判断への答え（投稿の前の質問なら、その答えと、ship が返した書きかけの計画のパスも）。
   - worktree は ship が Issue ごとに作る。1つの worktree を複数の ship で共有しない。
   - 着手宣言は ship がこのセッションの ID で出す（入れ子のサブエージェントにも `AGENT_HARNESS_SESSION` が同じ値で渡るので、`critic-input`・`post-plan`・`worktree` は止まらない）。
2. ship が返したら、その結果（状態・人に聞くこと・人がすることの項目・待つ理由）を控え、`fleet-status` を読み直して次を決める。セッションの記憶に頼らない。
   - 「入れ子不可」：Agent ツールが無く ship の中でサブエージェントを呼べない。以降はこのセッションで交互の方式（手順2〜5）に切り替える。
   - 人の判断待ち：手順9の前でも、たまったらまとめて AskUserQuestion で聞いてよい（1回に4問まで）。答えを渡して、その Issue の ship を呼び直す。人が拒んだ・答えなかったら、その Issue は人の判断待ちのまま一覧に書く。
   - 投稿の前の質問（ship が計画を投稿せずに返した Planner の質問）：ship の宣言が `plan` のまま残っているので、手順9を待たずに、返った質問を複数の Issue の分もまとめて AskUserQuestion で聞く（1回に4問まで。残りは次の回。おすすめを先頭）。答えと、ship が返した書きかけの計画のパスを渡して、その Issue の ship を呼び直す。人が拒んだ・答えなかった質問は「答え無し」として渡して呼び直す（ship は申告を残して投稿し、`post-plan` が宣言を解除する。同じ質問を繰り返さない）。聞けないまま、または呼び直せないままセッションを終えるときは、その Issue を `node harness/scripts/agent.ts release <番号>` で解除し、手順9の一覧に「投稿の前の質問に答えが無く、計画は投稿していない（次は plan から）」と書く。
   - 待つ（重なり・PR 同士の衝突・`--max` の本数・領域の上限）：表で「選ぶ」に戻るまで呼び直さない。領域の上限で待つ Issue は、fleet が `claim <番号> --manual --stage implement --force` で宣言し直してから呼び直してよい（fleet は領域の上限を見ないため）。
   - Merge 済みの Issue が出たら、次にやることが sync になった残りの PR の ship を呼び直す。
3. 「選ぶ」の Issue が全部、人の Merge 待ちか人の判断待ちになるまで、1〜2を繰り返す。その後、手順6〜9に進み（手順9の一覧は、ship が返した人がすることの項目をまとめる）、人の判断待ちだけが残ったのでなければ、終わらずに節「待つ間の読み直し」へ進む。

## Orca の worker で ship を動かすとき

`fleet.shipMode` が `worker` で、かつ Orca があるときだけ、Issue ごとに ship を Orca の worker（独立した Claude のセッション）で起こす（#197。人の決定 2026-09-30）。既定の `subagent` と、Orca が無いときの手順（「手順」「入れ子の方式（orca）」の節）は変えない。ここに書いていないことは、上の節（入力・選び方・手順）のとおりに進める。hq に起こされた fleet（節「Orca の worker として動くとき」）も、この節で ship を worker で動かしてよい（質問は ship → fleet → hq の順に `ask` で上げる）。

Orca のコマンドは、orchestration の skill（[.claude/skills/orchestration/SKILL.md](../orchestration/SKILL.md)）の「Resolve the CLI for this session」で決めた実行ファイルを使う（下では `ORCA` と書く。そのまま打たずに置き換える。Linux で素の実行ファイル名を使わない）。細部は `ORCA skills get orchestration` の、版に合った案内に従う。

1. **Orca の有無を確かめる**：`node harness/scripts/panes.ts config` の `shipMode` が `worker` のとき、`ORCA status --json` と `ORCA skills get orchestration` を走らせる。両方が成功すれば、この節で進める。どちらかが失敗したら、Orca が無い・動かないとして、今の手順（「手順」と「入れ子の方式（orca）」の節。中身は変えない）で進める（戻り先は下の 7）。この分かれ道は、入口の skill（orca-cli・orchestration）の「エラーを報告して止まる」「`ORCA open` で起動する」より優先する。`ORCA open` は試さない。
2. **Run を作る**：`ORCA orchestration run-create --objective "<テーマか Issue 番号の集合>" --json` で fleet の Run を1つ作り、ship の worker の `worker-start`・`check`・`worker-list` には `--run <fleet の Run ID>` を付ける。hq の Run と分かれるので、hq が数える fleet に ship の worker が混ざらない。
3. **worker を起こす条件**：`node harness/scripts/agent.ts fleet-status` の「選ぶ」の Issue のうち、次にやることが段階（plan・implement・judge・fix・sync）で、控え（scratchpad の `fleet-ship-workers.json`：Issue 番号・Dispatch ID・worktree・起こしたときの次にやること）に settle していない Dispatch が無い Issue だけを起こす。
   - `worker_done`（人の判断待ち・人の Merge 待ち）で返った Issue は、表の次にやることが控えと変わるまで起こし直さない。
   - 「—」（計画ゲート・判定の受け付け・Merge 経路を待つ）の Issue は起こさない。
   - 同時に動かすのは、表の「同時に動かす ship は <n> まで」の数まで。
4. **worker を起こす**：Issue ごとに次の順で進める。
   - `node harness/scripts/agent.ts claim <番号> --manual --stage <次にやることの段階>`（次の `worktree` がこのセッションの宣言を要るため。PR の段階なら `node harness/scripts/agent.ts claim <PR番号> --manual --stage judge|fix|sync`）
   - `node harness/scripts/agent.ts worktree claude/issue-<番号>-<短い名前>`（PR があれば、その head のブランチ）
   - `ORCA terminal create --worktree path:<worktree の絶対パス> --json` で素のシェルのターミナルを作り、`ORCA terminal send --terminal <handle> --text "claude --permission-mode auto" --enter` で権限モードを明示して Claude を起動する（`--command` に空白を含めて渡さない決まりのため、`terminal send` で送る）。
   - `ORCA terminal read --terminal <handle> --json` で起動した画面を読み、モードの表示が `auto mode` かを確かめる。bypass（`bypass permissions`）だった・auto でない・確かめられないときは、その worker を起こさず、`ORCA terminal close --terminal <handle>` で閉じ、その Issue を進めずに人に返す（hq に起こされた fleet なら hq に `escalation`）。
   - `node harness/scripts/agent.ts release <番号>`（worker が自分のセッションで宣言し直すため）
   - `ORCA orchestration worker-start --spec "<仕様>" --worktree path:<worktree の絶対パス> --terminal <handle> --run <fleet の Run ID> --json`。受け取った Dispatch ID を控えに書く。
   - Issue #197 の本文は `--agent claude` で起こすと書いているが、`worker-start` には権限モードを渡すフラグが無く、人の決定（2026-09-29：権限モードを明示して起動し、画面の表示を確かめる）を守れない。そのため `--agent claude` を使わず、権限モードを明示して起動したターミナルを `--terminal` で渡す。
5. **仕様**：`--spec` は Task-spec の5項目（対象・すること・守ること・持ち分・終わりの確かめ）で、それだけで分かるように書く。
   - 対象：Issue 番号、worktree の絶対パス、`node harness/scripts/agent.ts fleet-status` に渡す番号の集合と `--max`
   - すること：ship の skill（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）で、人の Merge 待ちか人の判断待ちまで進める
   - 守ること：最初に自分のセッションで `node harness/scripts/agent.ts claim <番号> --manual --stage <段階>` を出す。領域の上限で止まったら `--force` を付けて宣言し直す（fleet は領域の上限を見ないため）。ほかのセッションの宣言で止まったら何もせず、`worker_done` を `--outcome failed` で送る。人に聞くところは AskUserQuestion を使わず、前置きの `ask` で fleet に聞く。bypass permissions で動いていると分かったら進めず、`--outcome failed` で返す。Merge・Draft の解除・保護ラベルの付け外しをしない
   - 持ち分：その Issue の worktree の中だけを書き換える
   - 終わりの確かめ：人がすることの項目を `--report-path` のファイルに書き、`worker_done` を1回だけ送る。人の判断待ちで止めるなら `node harness/scripts/agent.ts release <番号>` で解除してから送る
6. **待つ・答える**：`ORCA orchestration check --wait --run <fleet の Run ID> --types "worker_done,escalation,question" --json` で待つ。
   - 状態の正は GitHub（`node harness/scripts/agent.ts fleet-status`）で、人の判断の正はラベル。Orca の decision gate は知らせるだけで、判断の正にしない。
   - `question`：fleet が答えられないもの（人の判断）は、今の手順のとおり AskUserQuestion で人に聞く（hq に起こされた fleet なら、節「Orca の worker として動くとき」の 5 のとおり hq に `ask` で上げる）。答えは `ORCA orchestration reply --id <message_id> --body "<人の答え>" --run <fleet の Run ID> --json` で、人の言葉のまま worker に返す。
   - `escalation`：理由を人がすることの一覧に書く（hq に起こされた fleet なら hq に `escalation` で送る）。
   - `worker_done`：`--report-path` のファイルを読み、控えを直し、`node harness/scripts/agent.ts fleet-status` を読み直して、上の 3 の条件で次の worker を起こす。settle した worker は `ORCA orchestration worker-release --dispatch <Dispatch ID> --json` で解放する。
   - 束の中の heartbeat（ship の worker の生存の知らせ）は、読んだらすぐ `--ack <delivery_id>` して、question・escalation・worker_done を後回しにしない（hq の手順7と同じ扱い。heartbeat を ack しないと、その後ろに並んだ question に届かない）。
   - fleet の `release` から worker の `claim` までの間にほかのセッションが宣言したときは、worker が failed の `worker_done` で返る。控えの Dispatch を settle 済みにして解放し、次の読み直しでその Issue が「着手宣言あり」なら起こし直さず、最後の一覧に「#番号 は session … が着手中」と書く（引き継ぐかは人が決める）。
   - hq に起こされた fleet は2つを読む：前置きの `check`（hq からの指示）と、自分の Run の `check --run <fleet の Run ID>`（ship の worker）。段階の切れ目（`worker_done` を受けたとき・`fleet-status` を読み直すとき）には、先に前置きの `check` で hq の指示を読み、次に自分の Run を読む。自分の Run の `check --wait` は `--timeout-ms` を付けて区切り、区切りごとに前置きの `check` と heartbeat をはさむ。
7. **起動に失敗したとき**：`worker-start`（または上の 4 の起動・画面の確かめの手前の Orca のコマンド）が 0 以外で終わった Issue は出し直さず、このセッションで今の手順で進める。
   - hq に起こされていない fleet：入れ子の方式（`fleet.nesting` が `orca`）か、交互の方式（`flat`、または入れ子にできないとき）。
   - hq に起こされた fleet（前置きがあるとき）：入れ子の方式に戻るだけ。入れ子にできなければ、節「Orca の worker として動くとき」の 2 のとおり理由を hq に `escalation` で送って止める（交互の方式では fleet がファイルを書き換えるため）。
   - ship をサブエージェントとして並べる決まり（交互の方式では ship をサブエージェントにしない・入れ子の方式の本数の上限）は残す。Orca の worker は独立したセッションなので、この決まりには当たらない。
8. **人がすることの一覧**：手順9の一覧は、各 worker の `worker_done` のレポートをまとめて作る。worker の ship の費用は、記録のディレクトリが worker ごとに分かれるので `node harness/scripts/agent.ts usage` の合計に入らない。一覧の「費用」にこの限界を書く（合計は別の Issue。人の決定 2026-09-30）。

## Orca の worker として動くとき

hq（テーマごとの fleet をまとめる付き添いのセッション）が Orca の orchestration で起こした fleet の手順。人に聞く窓口は hq にまとめる（ship → fleet → hq → 人）。ここに書いていないことは、上の節（入力・選び方・手順・入れ子の方式）のとおりに進める。

Orca のコマンドは、orchestration の skill（[.claude/skills/orchestration/SKILL.md](../orchestration/SKILL.md)）の「Resolve the CLI for this session」で決めた実行ファイルを使う（下では `ORCA` と書く。そのまま打たずに置き換える）。細部は `ORCA skills get orchestration` の、版に合った案内に従う。

1. **当てはまるとき**：プロンプトに orchestration の注入の前置き（Task ID・Dispatch ID・worker の handle・capability）があるとき。前置きが無ければこの節は使わず、今までどおり AskUserQuestion で人に聞く。前置きのコマンド（実行ファイル・handle・capability・ID）は写して使い、組み立て直さない。
2. **ship の動かし方を読む**：最初に `node harness/scripts/panes.ts config` を読む。
   - `worker`：節「Orca の worker で ship を動かすとき」で、ship を Orca の worker として起こす（ship の worker は fleet の Run に入れ、質問は ship → fleet → hq の順に `ask` で上げる）。その節の 1 で Orca が動かなければ、または起動に失敗したら、その節の 7 のとおり入れ子の方式に戻る。
   - `subagent`（既定）：入れ子の方式で進める。
   - 終了コード 1（設定の誤りなど）：着手宣言をせず、何もしないで止める。標準エラーの理由を hq に `escalation` で送り、`worker_done` を `--outcome failed` で送る。
   - 表の「進め方」が交互（flat）のとき、または ship が「入れ子不可」を返したときも、同じく理由を hq に送って止める。交互の方式では fleet が worktree で自分でファイルを書き換えることになり、下の 4 に反するため。止めるときに着手宣言が残っていれば `release <番号>` で解除する。
3. **ペインを作る**：並びは、左に fleet の Claude（縦いっぱい）、右に上から 進み具合 → あなたがすること → PR と費用（hq のペインと同じ「左に Claude・右に縦に3つ」）。

   ```
   ┌──────────────┬──────────────────┐
   │              │ 進み具合         │
   │  fleet の    ├──────────────────┤
   │  Claude      │ あなたがすること │
   │              ├──────────────────┤
   │              │ PR と費用        │
   └──────────────┴──────────────────┘
   ```

   - 作り方：fleet の Claude のターミナル（前置きの handle。無ければ `ORCA terminal list --worktree current --json` で自分のもの）を `ORCA terminal split --terminal <fleet の handle> --direction vertical --json` で左右に分ける（右が進み具合）。右にできたペイン（進み具合）を `ORCA terminal split --terminal <進み具合 の handle> --direction horizontal --json` で上下に分け（下があなたがすること）、あなたがすること のペインをもう一度 `--direction horizontal` で分ける（下が PR と費用）。左の fleet の Claude のペインは分け直さない（縦いっぱいのまま）。
   - 向き：Orca 1.4.216 では、`orca-cli` の案内（「`--direction horizontal` splits left/right」）と実際の向きが逆で、`--direction vertical` で左右、`--direction horizontal` で上下に分かれる。この skill の向きに従い、案内に合わせて `vertical` と `horizontal` を入れ替えない（#430。案内に従って下に開いた）。
   - 分けた後の確かめ：コマンドを送る前に `ORCA terminal list --worktree current --include-visual-layouts --json` で fleet のタブのペインの木（`visualLayouts` の `panes`）を読み、fleet の Claude の handle が `direction` が `vertical` の分け目の `first`（左）で、その `second`（右）が `horizontal` の分け目で上（`first`）から 進み具合 → あなたがすること → PR と費用 の handle の順になっているかを確かめる。違えば、作った表示のペインだけを `ORCA terminal close --terminal <handle>` で閉じ（閉じる前の確かめは手順7と同じ。閉じる handle が控えた表示のペインの handle で、fleet 自身の Claude の端末の handle と違うこと）、作り方から分け直す。2回分け直しても違えば、表示のペイン無しで進め、hq に `status` で知らせる（fleet の仕事を止めない）。
   - 分けたペインで動かすコマンドは、`--command` に空白を含めて渡さない。`ORCA terminal send --terminal <新しい handle> --text "<コマンド>" --enter` で後から送る。
   - あなたがすること：`node harness/scripts/panes.ts todo --session <fleet のセッション ID>`
   - 進み具合：`node harness/scripts/panes.ts collect --session <fleet のセッション ID> --label "<テーマ>" [--cwd <fleet の作業ディレクトリ>] <Issue 番号>...`。GitHub を読むのはこのペインだけで、間隔は `panes.collectIntervalSeconds`
   - PR と費用：`node harness/scripts/panes.ts prs --session <fleet のセッション ID>`
   - セッション ID は fleet 自身のもの（`AGENT_HARNESS_SESSION`）。表示用のペインは Claude のセッションではないので、渡さないと fleet の宣言が「ほかのセッション」と表示される。テーマは hq の指示の名前（`fleet: #<Epic番号> <短い名前>` の名前）。名前は表示のためだけで、宣言・usage・`fleet-status` はセッション ID で見分ける。Issue 番号は `fleet-status` に渡す番号の集合と同じにする。
   - 作ったペインの handle を、どれがどのペインか（進み具合・あなたがすること・PR と費用）と一緒に控える（片付けで使う）。fleet 自身の Claude の端末の handle も「閉じないもの」として控える。比べる自分の handle は `ORCA terminal list --worktree current --json` から控えた自分のターミナルの handle にする（前置きの worker の handle は、`terminal list` の handle と同じ種類と確かめられたときだけ使う。種類が違うと比べても一致しないため）。
   - 対象の Issue が変わったら、進み具合のペインは閉じずに、`ORCA terminal send --terminal <進み具合 の handle> --interrupt` で collect を止め、新しい Issue 番号の collect のコマンドを `ORCA terminal send --terminal <進み具合 の handle> --text "<コマンド>" --enter` で送り直す（一番上の位置を保つ。分け直すと下にしかできないため）。止まらない・ペインが無いときは、表示のペイン3つを閉じて（閉じる前の確かめは手順7と同じ）、上の作り方と分けた後の確かめからやり直す。
4. **fleet は指揮と読むことだけ**：fleet はリポジトリのファイル（ワークスペースの checkout と Issue の worktree）を書き換えない。コードや docs の書き換え・commit・push は、ship が Issue の worktree の中でだけ行う。fleet がするのは、`fleet-status`・`panes.ts`・`usage`・`gh` で読むこと、ship を呼ぶこと、着手宣言（`claim`・`release`）、hq とのやり取り、intel への送信（下の 9）、ship を worker で動かすとき（節「Orca の worker で ship を動かすとき」）の `node harness/scripts/agent.ts worktree`（リポジトリの外に Issue の worktree を作るだけ）と、ship の worker の `terminal create`・`terminal send`・`worker-start`・`worker-release`、hq がいない間の質問の控え（`node harness/scripts/hq-state.ts pending`・`pending-add`・`pending-answer`・`pending-remove`。git の共通ディレクトリの下に書くだけで、作業ツリーの外。下の 5 の「hq がいないとき」）だけ。一時ファイルは scratchpad にだけ書く。
5. **人に聞く（ask）**：ship と fleet の手順が AskUserQuestion で聞くところでは、AskUserQuestion を使わず、前置きの `ask` のコマンドで hq に聞く。手順1の引き継ぎ、手順2と入れ子の方式の手順2の投稿の前の質問、`agent:plan-review` で進めてよいか、「進める／直す／やめる」、手順9の人の判断待ちなどがこれに当たる。前置きに無ければ、形は `ORCA orchestration ask --from <handle> --dispatch-capability <capability> --question "<質問>" --options "<おすすめ>,<ほかの選択肢>" --timeout-ms <ミリ秒>`。
   - 1回の `ask` に1問。質問には、Issue 番号・段階・なぜ人が要るかを1行で入れる。選択肢はおすすめを先頭に置く。聞き方の決まりは [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方と同じで、書式や既定の規則で決まることは聞かない。
   - 待つ間に時間切れや切断になっても、新しく聞き直さない。同じ質問の ID を `--resume <message_id>` に渡して待ち直す（同じ質問を二重にしない）。
   - hq が `reply` で返した本文を、人の答え（人の言葉のまま）として扱い、各 skill の手順どおりに続ける。投稿の前の質問なら、答えと書きかけの計画のパスを渡して ship を呼び直す。`agent:plan-review` で進めてよいかなら、答えのとおりに進めるか止める。
   - hq が「答え無し」（人が拒んだ・答えなかった）と返したら、各 skill の「人が答えなかった」ときの扱い（申告を残して投稿する、人の判断待ちのまま一覧に書く など）にする。同じ質問を繰り返さない。
   - `ask` を待つ間も、ほかの Issue の ship は進めてよい（止めるのは、聞いた Issue だけ）。
   - Orca のコマンドが動かないときは、そのエラーをそのまま示して止める。AskUserQuestion にも、別の実行ファイルにも切り替えない。人の判断待ちで止めるときと同じく、宣言は `release <番号>` で解除する。ただし Orca 自体は動いていて hq だけがいないと確かめられたとき（下の「hq がいないとき」の見なす条件）は、止めずに退行に進む。
   - **hq がいないとき**（#409。hq が落ちた・閉じられた）：
     - 見なす条件（両方を満たしたときだけ。一度の時間切れでは決めない）：きっかけは、hq への `ask` が時間切れになった（`--resume` で待ち直しても同じ）か、前置きの `check`・heartbeat が Orca のエラーで失敗したこと。確かめは、hq の Claude の端末（控えの `hqHandle`。`node harness/scripts/hq-state.ts ledger` で読む。控えが無ければ `ORCA orchestration run-show --id <hq の Run ID> --json` の `coordinator_handle`）を `ORCA terminal show --terminal <handle> --json` で読み、無い（エラー・live でない）ことを、5分以上あけた2回の読みで続けて確かめたこと。数えるのは `ORCA status --json` が成功している（Orca 自体は動いている）うえで `terminal show` がその handle が無い・live でないと返したときだけ。`ORCA status` も失敗するときは hq がいない証拠にせず、上の「Orca のコマンドが動かないとき」のとおり止める。端末があるなら hq はいる（人が答えていないだけ）ので、今までどおり `--resume` で待ち直す。
     - 退行（案A）：人の判断が要る Issue は `release <番号>` で宣言を解除して「人の判断待ち」として止め、ほかの Issue は進める。質問は `node harness/scripts/hq-state.ts pending-add --session <fleet のセッション ID> --issue <番号> --stage <段階> --question "<質問>" --option "<おすすめ>" --option "<ほか>" [--message-id <ask の message_id>]` で控え、`panes.ts todo`（あなたがすること）のペインの先頭に「hq がいない間の質問（fleet のタブで答える）」として出す。AskUserQuestion には切り替えない（fleet のタブに人がいるか分からないまま fleet 全体を止めないため）。
     - 二重に出さない：hq がいない間に出た新しい質問は `ask` せずに、同じく `pending-add` で控えに足す。
     - 人が fleet のタブ（fleet の Claude）で答えたら、それを人の答え（人の言葉のまま）として扱い、`node harness/scripts/hq-state.ts pending-answer --session <ID> --issue <番号> --answer "<人の答え>"` で答え済みにしてから、各 skill の手順どおりに続ける（宣言し直して ship を呼び直すなど）。続きを進めたら `pending-remove` で控えから外す。
     - hq が戻ったとき（前置きの `check` に新しい hq の `send`（件名 `hq-back`）が届いた、または控えの `hqHandle` が変わり、その端末が live）：答えの無い控えのうち `messageId` のあるものは `ask --resume <message_id>` で待ち直し（新しい hq が前の Run を引き継いで同じ質問を受け取るので、新しく聞き直さない）、`messageId` の無いものは新しく `ask` する。hq に上げた控えは `node harness/scripts/hq-state.ts pending-remove --session <ID> --issue <番号>` でペインから外す（人と hq に二重に出さない）。答え済みの控えは待ち直さない（新しい hq が控えを読み、その質問に本文 `fleet のタブで人が答え済み` で `reply` する）。
6. **hq からの追加の指示**：段階の切れ目（ship が返ったとき、`fleet-status` を読み直すとき）と `worker_done` の直前に、前置きの `check` のコマンドで hq の追加の指示を読む。前置きが求める間隔で heartbeat を送る（`ask`・`check --wait` の間は送らない）。
   - heartbeat の間隔：前置きの間隔より短い間隔で送らない。この節の 8 で `status` を送った直後の区切りでは、heartbeat を重ねて送らない（束を増やして hq の question を遅らせないため）。
   - heartbeat の本文に今の状況を一言入れる（#425）：前置きの heartbeat のコマンドを写し、一言を本文（`--body`）に入れる。入れるものは Issue 番号・段階・次にすること・待っているもの（例：「#388 実装中、次は判定」「#386 area:harness の上限の空き待ち」）。受け持つ Issue が複数なら、動いているもの・待っているものを短く並べる（1〜2行）。前置きの heartbeat の形が本文を持てないときは、一言を入れずに今までどおり送る（一言のために `status` を増やさない）。
   - 一言は知らせるだけで、heartbeat に質問を載せない。人の判断が要ることは今までどおり 5 の `ask`、報告・連絡は 8 の `status` で送る。一言のために heartbeat の間隔を変えない（#395 のまま）。hq は一言を読んで人がすることの一覧（hq の手順7・12）に使う。
7. **終わるとき**：途中の知らせは、この節の 8 で続けて送る（8 は終わるまでずっと続ける手順で、時間の順では 7 の前でもある）。`worker_done` を送るのは、受け持つ Epic が Close したときか、人の判断待ちだけが残ったとき（節「待つ間の読み直し」の 7）。それまでは手順9の一覧を scratchpad に書き直し、`check` で hq の指示を読みながら読み直しを続ける。手順9の人がすることの一覧は人に出さない。scratchpad のファイルに書き、`worker_done` を前置きのコマンドで1回だけ送る（本文は3文の要約。`--report-path` にそのファイルを渡し、`--outcome succeeded` にする。止まったときは `failed`）。
   - 送る前に、手順3で作った表示のペイン（進み具合・あなたがすること・PR と費用）を `ORCA terminal close --terminal <handle>` で閉じる。`ORCA terminal close` を送る前に毎回、閉じる handle が手順3で控えた表示のペインの handle で、fleet 自身の Claude の端末の handle と違うことを確かめる。同じなら閉じない（#409 で hq がペインを閉じたときに自分の端末まで閉じた見込みと同じことを、fleet で起こさないため）。
   - `ORCA terminal list --worktree current --json` で読み直して、閉じた後に残った空のシェルのペインも閉じる。このときも fleet 自身の Claude の端末の handle と比べ、同じものは閉じない。
   - ワークスペース（Orca の worktree）そのものは消さない（片付けるのは hq）。`worker_done` の後は、新しい作業を始めない。
   - hq に `ask` で聞いて答えを待っている Issue があるうちは、`worker_done` を送らない（読み直しと `ask --resume <message_id>` の待ちを続ける）。交代・Orca のエラーなどで答えを待たずに終えるしかないときは、その Issue を `release <番号>` で解除し、レポートに「hq に聞いた質問（message_id・質問）の答えを受け取っていない」と書いてから送る。
8. **hq に知らせる（send）**：途中の報告・連絡を、その都度 hq に `status` で送る。形は前置きの `--from`・`--dispatch-capability`・`--task-id`・`--dispatch-id` を写した `ORCA orchestration send ... --type status --subject "<件名>" --body "<1〜3行>"`（`--to` は付けない。worker が `--to` を省くと、自分の Dispatch の Run の mailbox（hq）に届く）。
   - 送る時機：ship が返ったとき・`fleet-status` を読み直したとき・節「待つ間の読み直し」で気づいたとき。
   - 報告（件名）：
     - `ready-<PR>`：PR が人の Merge 待ち（`human-merge`・`auto-merge`）になった。本文に Human Merge か自動 Merge か
     - `merged-<PR>`：Merge された
     - `verdict-<PR>`：判定に合格／不合格。本文に合否とブロッキングの件数
     - `wait-<Issue>`：fleet が Issue を待ちにした。本文に理由（重なり・PR 同士の衝突・`--max`・領域の上限・読み込みが古い）
   - 連絡（件名 `notice`）：着手宣言の引き継ぎ・宣言で負けた・衝突・main の取り込みで判定が外れた・ほかのセッションと重なった。本文の先頭に Issue／PR 番号。人の判断が要るなら本文にそう書く。
   - 相談：今の `ask`（この節の 5）のまま。人の判断が要るものは `status` で送らない。
   - 二重に送らない：送った件名と状態を scratchpad の `fleet-hq-sent.json` に控え、読み直しで同じ状態なら送らない（状態が変わったら送り直す）。
   - `status` は知らせるだけで、判断の正は GitHub（`fleet-status`）とラベル。
9. **範囲の外の気づき**（#396）：ship・fleet が進める中で見つけた、今の Issue の範囲の外の気づき（仕組みの問題・改善案・Issue の種。今すぐの判断が要らないもの）は、hq を通さずに `SendMessage` の `to: intel` で intel（[intel](../intel/SKILL.md)。本体のタブで待つ）に送る。本文は出どころ（テーマ・Issue 番号）・要点・根拠。返事は待たない。
   - 人の判断が要るもの（今の進め方を決めるもの）は、今までどおり 5 の `ask` で hq に上げる（hq に聞けない障害なら `escalation`）。1つの気づきに両方が混ざるときは分け、判断の要る部分は hq に上げ、残りを intel に送る。迷ったら intel ではなく hq に上げる側にする（判断の要るものを intel に流して止めないため。hq の skill の「相談・アイデアを intel に回す」と同じ考え方）。
   - intel がいない（`ListAgents` に無い・`SendMessage` が失敗した）ときは送らずに、手順9の一覧（`worker_done` のレポート）に「intel に回せなかった気づき」として書く。

## ハーネスが更新されたときの交代

Claude Code は担当の定義・CLAUDE.md・skill をセッションの開始時に読むので、始めた後に main でハーネスが変わっても、このセッションは古いまま動く（#199）。SessionStart の hook が始めたときの読み込みの版を記録し、`node harness/scripts/agent.ts harness-drift`・`fleet-status`・`claim` がそれを origin と比べる。

1. **見る**：手順1・3と節「待つ間の読み直し」で `fleet-status` を読むたびに、表の下の「このセッションの読み込みは古い」の行を見る（無ければ `node harness/scripts/agent.ts harness-drift` の `stale`）。`claim` も古いと標準エラーに一言出す。
2. **古いとき**：新しい段階・新しい ship を始めない。入れ子の方式では、動いている ship が段階の切れ目で返るのを待つ（ship は「待つ（読み込みが古い）」で返る）。その後、このセッションの着手宣言を `release <番号>` で全部解除し、その後（段階の切れ目）でだけ交代する。段階の途中では交代しない。**judge の段階は、古いセッションでは始めない**（`claim --stage judge` と `step` も止める。止まる理由 `harness-stale`）。
3. **聞く**：AskUserQuestion で「交代しますか」を聞く（おすすめは「交代する」。Orca の worker のときは節「Orca の worker として動くとき」のとおり hq に `ask`）。拒まれた・答えが無いときは同じ質問を繰り返さず、下の 5 の1行を示して止まる。
4. **Orca があるとき（承認の後）**：Orca の CLI は orca-cli の skill の「Resolve the CLI for this session」で選ぶ（Windows のほかでは素の `orca` を使わない）。
   - 本体（`git rev-parse --path-format=absolute --git-common-dir` の親。hq と同じ main の checkout）が既定ブランチで未 commit の変更が無ければ、`git -C <本体> pull --ff-only` で origin に追いつかせる。できなければ起動せず、理由と 5 の1行を示して止まる。
   - orca-cli の skill の端末の起動（`terminal create`。引数は Orca の `skills get` の案内に従う）で、本体で `claude --permission-mode auto "/fleet --epic <Epic番号> <番号…>"` を起動する（番号は `fleet-status` に渡した集合。受け持つ Epic が無ければ `--epic` を付けない）。権限モードは必ず明示する（人の決定 2026-09-29）。Epic の fleet なら端末の表示名を `fleet: #<Epic番号> <短い名前>` にしてよい（表示のためだけで、着手宣言・usage はセッション ID で見分ける）。
   - 起動後に画面のモード表示が `auto mode` かを確かめる。bypass（`bypass permissions`）だった・確かめられないときは、新しいセッションに段階を進めさせずに人に返す。
   - 確かめられたら、引き継ぎの要約（受け持つ Epic、人の判断待ちと待つ理由、進めている Issue・PR）を示して、このセッションは終える（新しい fleet が `fleet-status` を読み直して続きから進め、Epic の終わりまで続ける）。
5. **Orca が無い・動かないとき**：止まって、人が新しいセッションに渡す1行 `/fleet --epic <Epic番号> <番号…>`（Epic が無ければ `/fleet <番号…>`）と、始め方（本体を `git pull --ff-only` で追いつかせてから `claude --permission-mode auto` で起動し、画面の `auto mode` を確かめる）を示す。

## 待つ間の読み直し

App の計画ゲート・判定の受け付け・自動 Merge・CI を待つ間も、fleet が見る（#199。人の決定 2026-09-30）。

1. **いつ**：選んだ Issue が全部「待つ」（App・CI 待ち）か人の Merge 待ち（`human-merge`・`auto-merge`）になったら、手順9の一覧を出した後も終わらずに、表の下の間隔（`harness.config.json` の `fleet.watch.intervalMinutes`、既定 3 分）ごとに `node harness/scripts/agent.ts fleet-status --watch <番号>...` を読み直す。待ち方は付き添いのセッションの中の道具（Bash の `run_in_background` の until ループ・Monitor など）で、schedule・Actions・クラウドの Routine は使わない。
2. **交代の行もここで見る**：読み直すたびに、表の下の「このセッションの読み込みは古い」の行も見る（節「ハーネスが更新されたときの交代」）。
3. **ship を呼び直す**：次にやることが出たら（plan-ok・fix など）、または表の下の「Merge 後の見届けが済んでいない」の行（Issue が開いている・`claude/issue-<番号>-` の worktree が残る。見張りの記録に頼らず事実で見分けるので、最初の読み直しでも交代の後の新しい fleet でも出る）が出たら、その Issue の ship を呼び直す（Merge の後は Epic #281 の決定どおり、ship が Merge 後の確かめ・worktree の片付け・Close の見届けをする）。
4. **「Close されていない」の扱い**：このセッションで既に呼び直して ship が「Close されていない（理由）」で返した Issue は、人の判断待ちとして手順9の一覧に載せ、同じ行が出続けても呼び直さない。この印はセッションの中で持ち、見張りの記録には残さない。交代の後の新しい fleet は最初の1回だけ呼び直す。終わり方の「人の判断待ちだけが残った」でもこの Issue を人の判断待ちに数える。
5. **自分の PR の sync**：自分の行（`fleet-status` に渡した Issue の PR）の次にやることが `sync` になったら、`human-merge`・`auto-merge` の段階でも、その Issue の ship をすぐ呼び直して sync させる。fleet 自身は衝突を直さない（直すのは ship）。ほかのセッション・持ち主のいない PR は対象にしない。
6. **App が動かないとき**：表の下に「App が動いていない」の行（`fleet.watch.appStallMinutes`、既定 20 分以上、計画ゲートの記録が付かない・auto-merge が付いたまま Merge されない）が出たら、人に知らせる（付き添いでは文章で。Orca の worker のときは節「Orca の worker として動くとき」のとおり hq に `escalation`）。同じ行を知らせるのは1回だけで、その後も読み直しを続ける。
7. **終える**：読み直しを終えるのは、受け持つ Epic が Close したとき（`gh issue view <Epic番号> --json state`。その後に手順6〜9の最後の一覧を出す）と、人の判断待ち（`plan-review`・止まる印・各 skill の人に返す条件・上の 4）だけが残ったとき。受け持つ Epic が無い fleet は、選んだ Issue が全部 Merge 済み（見届け済み）か人の判断待ちになったとき。

## 終わりの状態

- 受け持つ Epic が Close した（Epic が無い fleet は、選んだ Issue が全部 Merge 済み（見届け済み）か人の判断待ちになった）か、人の判断待ちだけが残っている（`node harness/scripts/agent.ts fleet-status --watch` の表で確かめた）。人の Merge 待ち・App 待ちが残る間は終わらず、節「待つ間の読み直し」を続ける。
- 人がすることの一覧（トークン数・推定料金・改善の候補を含む）を出した。
- 続けて使わない worktree は `node harness/scripts/agent.ts worktree-remove <ブランチ>` で消した。

## 人に返す条件

途中で人に返すとき（下のどれに当たったときも）も、手順8の振り分けをして改善の候補を示してから返す。

- ship の「人に返す条件」に当たった（その Issue は止めて人に返し、ほかの Issue は進める。一覧にまとめて返す）
- 選べる Issue が無い（止まる印・依存・着手宣言・重なり・PR 同士の衝突・`--max` の本数で全部が待つ）
- 選んだ Issue が全部待つ状態になり、人の判断待ちだけが残った（App・CI 待ち・人の Merge 待ちが残る間は人に返さず、節「待つ間の読み直し」を続ける）
- 交代を拒まれた、または交代の後に `auto mode` を確かめられない（節「ハーネスが更新されたときの交代」）
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge`・auto mode のラベル（既定 `agent:auto-mode`。名前は `harness.config.json` の `autoMode.label`）と `*:exempt` のラベルの付け外し
