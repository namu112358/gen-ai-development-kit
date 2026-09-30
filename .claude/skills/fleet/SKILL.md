---
name: fleet
description: 人が付き添うセッションで、複数の Issue を選び、ship を Issue ごとにサブエージェントで並行に動かして（入れ子にできなければ ship の各段階を交互に進めて）、全部を人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを1つの一覧にする。「複数の Issue をまとめて進めて」「fleet で進めて」と頼まれたときに使う。
---

# fleet（複数の Issue を並行して進める）

ship（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）を複数の Issue について進める手順。各段階の中身は ship と各 skill に従い、ここに写さない。進め方は2つあり、`fleet-status` の表の末尾の「進め方」の行（`harness.config.json` の `fleet.nesting`）で決まる。

- **入れ子（orca、既定）**：サブエージェントの中でさらにサブエージェントを呼べる環境（Orca）で、Issue ごとに ship をサブエージェントとして並行に動かす（fleet > ship > plan-critic・test-designer・reviewer・risk-agent）。1つの Issue のコードの読み書きは、その ship のコンテキストに閉じる。手順は「入れ子の方式」の節。
- **交互（flat）**：1つのセッションの中で、ship の段階を Issue ごとに交互に進める。ship の中でサブエージェントを呼ぶので、ship そのものをサブエージェントにしない。手順は「手順」の節の2〜5。入れ子の方式でも、ship が「入れ子不可」を返したらこちらに切り替える。

hq に Orca の worker として起こされたとき（プロンプトに orchestration の注入の前置きがある）は、節「Orca の worker として動くとき」にも従う。それ以外のときは、その節を読まない。

## 入力

- 対象：Issue 番号の一覧（任意）。無ければ `agent:ready`・`agent:plan-ok`・`agent:plan-review` の開いた Issue と、`agent:*` の無い、コラボレーター（OWNER・MEMBER・COLLABORATOR）か App（Epic の子課題など）が立てた開いた Issue（作ったまま計画に進んでいないもの）から選ぶ（`harness/lib/fleet.ts` の `fleetTargets`）
- 複数の Issue を作る依頼（「〜を Issue にして進めて」）なら、ship の入力と同じ書き方で作り、作った番号を対象にして、人が「作るだけ」と言わない限り同じセッションで plan から fleet を続ける
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

1. `node harness/scripts/agent.ts fleet-status`（対象を指定されたら番号も、本数を絞るなら `--max <n>` も渡す）で表を出し、「選ぶ」の Issue を控える。以降は同じ番号を渡して表を読み直す。選べる Issue が無ければ、待つ理由を添えて人に返す。表の末尾の「進め方」の行が入れ子（orca）なら、この手順1の宣言の扱いを守ったまま「入れ子の方式」の節で進め、交互（flat）なら手順2〜5で進める。`fleet-status` が `harness.config.json` の `fleet` の誤りで止まったら、人に返す（方式を推測で選ばない）。
   - このセッションの着手宣言（宣言の session が今のセッションの ID と同じ）は選ばれ、メモに段階が出る。PR の無い段階は Issue の宣言を、PR の段階は PR の宣言（`claim <PR番号> --stage judge|fix|sync`）を見る（メモには「PR の着手宣言」と出る）。「着手宣言あり」で選ばれない Issue が止まった前のセッションの途中のもの（`/clear` で ID が変わった場合を含む）なら、引き継ぐかを AskUserQuestion で人に確かめてから `node harness/scripts/agent.ts claim <番号> --manual --takeover` で引き継いで読み直す（PR の段階なら `claim <PR番号> --manual --stage judge|fix|sync --takeover`）。
   - Issue に手を付ける最初に、ship と同じく `claim <番号> --manual --stage <段階>` で宣言する。人の判断待ちで止めてセッションを終えるときは `release <番号>` で解除する。
   - `claim` が「先に宣言したセッションがある」で止まったら（同時に宣言して後の側になった。自分の宣言は取り下げ済み）、その Issue を飛ばして次の Issue へ進み、最後の一覧に「#番号 は session … が着手中」と載せる（引き継ぐかは人が決める）。
   - 着手宣言（`claim <番号> --manual`）が領域の上限で止まったら、`--force` を付けて宣言する（fleet は領域の上限を見ないため）。
2. 「選ぶ」の Issue ごとに（選択が「待つ」の行は、次にやること（fix・judge など）が出ていても進めない）、表の「次にやること」の段階を ship と同じ判断（ship の手順2〜6）で1つ進める。
   - plan：plan の skill。批評（plan-critic）は Issue ごとに並行して呼んでよい。Planner の質問（`openQuestions`・`needsHumanReasons`）は plan の skill の手順3どおり投稿の前に AskUserQuestion で聞く（複数の Issue の質問を1回にまとめてよい。1回に4問まで）。入れ子の方式では ship が投稿せずに質問を返すので、「入れ子の方式」の手順2でまとめて聞き、答えを渡して ship を呼び直す。計画ゲートが `agent:plan-review` で止めた Issue は、ship の手順2と同じく、宣言が残っていれば `release <番号>` で解除してから、進めてよいかを聞く（手順8でまとめて聞いてよい）。Planner の申告で止まったら、ship の手順2どおり人の答えを `post-decision` で記録する。
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
5. 「選ぶ」の Issue が全部、人の Merge 待ち（Ready・人の Merge 待ち、自動 Merge 待ち）か人の判断待ち（plan-review、止まる印あり、各 skill の人に返す条件）になるまで、手順2〜4を繰り返す。
6. ラベル（`priority:*`・`area:*`）は、ship の手順8と同じく、まず Jev に任せ、App の名義の `kind=label-triage` の記録の `notApplied` がまだ足りなければ、本文と Jev の提案を見て決めて付け、付けたラベルと理由を Issue のコメントに残す。記録が無ければ付けない。人や App が付けたラベル・`type:*`・違反は変えない。不足や違反を手順8の一覧に書かず、人にも聞かない。
7. `node harness/scripts/agent.ts usage` で、このセッションのトークン数と推定料金を読む（入れ子の方式の ship とその中の担当の記録も、このセッションの `subagents/` に置かれるので集計に入る）。
8. 人に**人がすること**の一覧を1つにまとめて出す（Issue・PR ごとに ship の手順9と同じ項目）。
   - Merge：Human Merge の PR（Merge の順番に意味があれば順番も）。自動 Merge なら何もしない（止めたければ `agent:hold`）
   - 例外ラベル：`test:exempt` は自動 Merge の対象の PR で `agent/tests` が failure のときだけ（Human Merge の PR では付けず、依頼のコメントに載ったテストの変更を Merge の前に確かめる、を「Merge」の項に書く）。`review:exempt` は付けるかの判断。どちらも、その理由を書いた場所
   - `node harness/scripts/setup.ts` の実行が要る変更か
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - 人の判断待ち：どの Issue の、どの段階の、何を決めてほしいか。一覧を出した後に AskUserQuestion でまとめて聞く（1回に4問まで。聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。入れ子の方式の投稿の前の質問で答えが無いまま終える Issue は、`release <番号>` で解除してから「計画は投稿していない」と書く
   - 待たせた Issue と理由（重なり・PR 同士の衝突・`--max` の本数）
   - 宣言で負けて飛ばした Issue：「#番号 は session … が着手中」
   - 費用：進めた本数と、手順7のトークン数・推定料金

## 入れ子の方式（orca）

表の「進め方」の行が入れ子（orca）のときの、手順2〜5の代わり。手順1・6〜8と「選び方」はそのまま使う。

1. 表の「選ぶ」の Issue ごとに、ship の skill を general-purpose のサブエージェントで呼ぶ。同時に動かすのは、表の「同時に動かす ship は <n> まで」の数まで（`--max` があれば `--max`、無ければ `fleet.maxParallelShips`）。残りは、1つ返るたびに表を読み直してから呼ぶ。
   - 渡すもの：Issue 番号、「サブエージェントの ship として動く（ship の skill の「サブエージェントの ship として動くとき」の節に従う）」こと、fleet が `fleet-status` に渡した Issue 番号の集合と `--max`（ship が同じ引数で表を読むため）、呼び直すときは人の判断への答え（投稿の前の質問なら、その答えと、ship が返した書きかけの計画のパスも）。
   - worktree は ship が Issue ごとに作る。1つの worktree を複数の ship で共有しない。
   - 着手宣言は ship がこのセッションの ID で出す（入れ子のサブエージェントにも `AGENT_HARNESS_SESSION` が同じ値で渡るので、`critic-input`・`post-plan`・`worktree` は止まらない）。
2. ship が返したら、その結果（状態・人に聞くこと・人がすることの項目・待つ理由）を控え、`fleet-status` を読み直して次を決める。セッションの記憶に頼らない。
   - 「入れ子不可」：Agent ツールが無く ship の中でサブエージェントを呼べない。以降はこのセッションで交互の方式（手順2〜5）に切り替える。
   - 人の判断待ち：手順8の前でも、たまったらまとめて AskUserQuestion で聞いてよい（1回に4問まで）。答えを渡して、その Issue の ship を呼び直す。人が拒んだ・答えなかったら、その Issue は人の判断待ちのまま一覧に書く。
   - 投稿の前の質問（ship が計画を投稿せずに返した Planner の質問）：ship の宣言が `plan` のまま残っているので、手順8を待たずに、返った質問を複数の Issue の分もまとめて AskUserQuestion で聞く（1回に4問まで。残りは次の回。おすすめを先頭）。答えと、ship が返した書きかけの計画のパスを渡して、その Issue の ship を呼び直す。人が拒んだ・答えなかった質問は「答え無し」として渡して呼び直す（ship は申告を残して投稿し、`post-plan` が宣言を解除する。同じ質問を繰り返さない）。聞けないまま、または呼び直せないままセッションを終えるときは、その Issue を `node harness/scripts/agent.ts release <番号>` で解除し、手順8の一覧に「投稿の前の質問に答えが無く、計画は投稿していない（次は plan から）」と書く。
   - 待つ（重なり・PR 同士の衝突・`--max` の本数・領域の上限）：表で「選ぶ」に戻るまで呼び直さない。領域の上限で待つ Issue は、fleet が `claim <番号> --manual --stage implement --force` で宣言し直してから呼び直してよい（fleet は領域の上限を見ないため）。
   - Merge 済みの Issue が出たら、次にやることが sync になった残りの PR の ship を呼び直す。
3. 「選ぶ」の Issue が全部、人の Merge 待ちか人の判断待ちになるまで、1〜2を繰り返す。その後、手順6〜8に進む（手順8の一覧は、ship が返した人がすることの項目をまとめる）。

## Orca の worker として動くとき

hq（テーマごとの fleet をまとめる付き添いのセッション）が Orca の orchestration で起こした fleet の手順。人に聞く窓口は hq にまとめる（ship → fleet → hq → 人）。ここに書いていないことは、上の節（入力・選び方・手順・入れ子の方式）のとおりに進める。

Orca のコマンドは、orchestration の skill（[.claude/skills/orchestration/SKILL.md](../orchestration/SKILL.md)）の「Resolve the CLI for this session」で決めた実行ファイルを使う（下では `ORCA` と書く。そのまま打たずに置き換える）。細部は `ORCA skills get orchestration` の、版に合った案内に従う。

1. **当てはまるとき**：プロンプトに orchestration の注入の前置き（Task ID・Dispatch ID・worker の handle・capability）があるとき。前置きが無ければこの節は使わず、今までどおり AskUserQuestion で人に聞く。前置きのコマンド（実行ファイル・handle・capability・ID）は写して使い、組み立て直さない。
2. **ship の動かし方を読む**：最初に `node harness/scripts/panes.ts config` を読む。
   - 終了コード 1（`fleet.shipMode` が `worker`）：着手宣言をせず、何もしないで止める。標準エラーの理由を hq に `escalation` で送り、`worker_done` を `--outcome failed` で送る。
   - `subagent`（既定）：入れ子の方式で進める。
   - 表の「進め方」が交互（flat）のとき、または ship が「入れ子不可」を返したときも、同じく理由を hq に送って止める。交互の方式では fleet が worktree で自分でファイルを書き換えることになり、下の 4 に反するため。止めるときに着手宣言が残っていれば `release <番号>` で解除する。
3. **ペインを作る**：fleet の Claude のターミナル（前置きの handle。無ければ `ORCA terminal list --worktree current --json` で自分のもの）を `ORCA terminal split --terminal <handle> --json` で3回分けて、4ペイン（fleet の Claude・進み具合・あなたがすること・PR と費用）にする。分けたペインで動かすコマンドは、`--command` に空白を含めて渡さない。`ORCA terminal send --terminal <新しい handle> --text "<コマンド>" --enter` で後から送る。
   - 進み具合：`node harness/scripts/panes.ts collect --session <fleet のセッション ID> --label "<テーマ>" [--cwd <fleet の作業ディレクトリ>] <Issue 番号>...`。GitHub を読むのはこのペインだけで、間隔は `panes.collectIntervalSeconds`
   - あなたがすること：`node harness/scripts/panes.ts todo --session <fleet のセッション ID>`
   - PR と費用：`node harness/scripts/panes.ts prs --session <fleet のセッション ID>`
   - セッション ID は fleet 自身のもの（`AGENT_HARNESS_SESSION`）。表示用のペインは Claude のセッションではないので、渡さないと fleet の宣言が「ほかのセッション」と表示される。テーマは hq の指示の名前（`fleet: #<Epic番号> <短い名前>` の名前）。名前は表示のためだけで、宣言・usage・`fleet-status` はセッション ID で見分ける。Issue 番号は `fleet-status` に渡す番号の集合と同じにする。
   - 作ったペインの handle を控える（片付けで使う）。対象の Issue が変わったら、進み具合のペインを閉じて作り直す。
4. **fleet は指揮と読むことだけ**：fleet はリポジトリのファイル（ワークスペースの checkout と Issue の worktree）を書き換えない。コードや docs の書き換え・commit・push は、ship が Issue の worktree の中でだけ行う。fleet がするのは、`fleet-status`・`panes.ts`・`usage`・`gh` で読むこと、ship を呼ぶこと、着手宣言（`claim`・`release`）、hq とのやり取りだけ。一時ファイルは scratchpad にだけ書く。
5. **人に聞く（ask）**：ship と fleet の手順が AskUserQuestion で聞くところでは、AskUserQuestion を使わず、前置きの `ask` のコマンドで hq に聞く。手順1の引き継ぎ、手順2と入れ子の方式の手順2の投稿の前の質問、`agent:plan-review` で進めてよいか、「進める／直す／やめる」、手順8の人の判断待ちなどがこれに当たる。前置きに無ければ、形は `ORCA orchestration ask --from <handle> --dispatch-capability <capability> --question "<質問>" --options "<おすすめ>,<ほかの選択肢>" --timeout-ms <ミリ秒>`。
   - 1回の `ask` に1問。質問には、Issue 番号・段階・なぜ人が要るかを1行で入れる。選択肢はおすすめを先頭に置く。聞き方の決まりは [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方と同じで、書式や既定の規則で決まることは聞かない。
   - 待つ間に時間切れや切断になっても、新しく聞き直さない。同じ質問の ID を `--resume <message_id>` に渡して待ち直す（同じ質問を二重にしない）。
   - hq が `reply` で返した本文を、人の答え（人の言葉のまま）として扱い、各 skill の手順どおりに続ける。投稿の前の質問なら、答えと書きかけの計画のパスを渡して ship を呼び直す。`agent:plan-review` で進めてよいかなら、答えのとおりに進めるか止める。
   - hq が「答え無し」（人が拒んだ・答えなかった）と返したら、各 skill の「人が答えなかった」ときの扱い（申告を残して投稿する、人の判断待ちのまま一覧に書く など）にする。同じ質問を繰り返さない。
   - `ask` を待つ間も、ほかの Issue の ship は進めてよい（止めるのは、聞いた Issue だけ）。
   - Orca のコマンドが動かないときは、そのエラーをそのまま示して止める。AskUserQuestion にも、別の実行ファイルにも切り替えない。人の判断待ちで止めるときと同じく、宣言は `release <番号>` で解除する。
6. **hq からの追加の指示**：段階の切れ目（ship が返ったとき、`fleet-status` を読み直すとき）と `worker_done` の直前に、前置きの `check` のコマンドで hq の追加の指示を読む。前置きが求める間隔で heartbeat を送る（`ask`・`check --wait` の間は送らない）。
7. **終わるとき**：手順8の人がすることの一覧は人に出さない。scratchpad のファイルに書き、`worker_done` を前置きのコマンドで1回だけ送る（本文は3文の要約。`--report-path` にそのファイルを渡し、`--outcome succeeded` にする。止まったときは `failed`）。
   - 送る前に、手順3で作った表示のペイン（進み具合・あなたがすること・PR と費用）を `ORCA terminal close --terminal <handle>` で閉じる。`ORCA terminal list --worktree current --json` で読み直して、閉じた後に残った空のシェルのペイン（fleet の Claude のターミナルでないもの）も閉じる。
   - ワークスペース（Orca の worktree）そのものは消さない（片付けるのは hq）。`worker_done` の後は、新しい作業を始めない。

## 終わりの状態

- 選んだ Issue が全部、人の Merge 待ちか人の判断待ちになっている（`node harness/scripts/agent.ts fleet-status` の表で確かめた）。
- 人がすることの一覧（トークン数・推定料金を含む）を出した。
- 続けて使わない worktree は `node harness/scripts/agent.ts worktree-remove <ブランチ>` で消した。

## 人に返す条件

- ship の「人に返す条件」に当たった（その Issue は止めて人に返し、ほかの Issue は進める。一覧にまとめて返す）
- 選べる Issue が無い（止まる印・依存・着手宣言・重なり・PR 同士の衝突・`--max` の本数で全部が待つ）
- 選んだ Issue が全部待つ状態になった
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge` と `*:exempt` のラベルの付け外し
