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
- 人の判断待ち（`plan-review`・Issue の止まる印）が `hq.humanWaitMinutes`（既定 120 分）を超えた Issue と、PR の止まる印（`agent:hold`・`agent:blocked`）の Issue は、脇に置く（`plan-review` は表の選択が「待つ：人の判断待ちが N 分…脇に置く」になる。`--json` の行の `humanWait` に始まり・分・`overdue`・決めてほしいこと。PR の止まる印は時刻を読まないので分は無い）。人の判断が付く（印が外れる・計画の出し直し）と、また「選ぶ」に戻る。脇に置いた `plan-review` の行も、読み直しのたびにship の手順2の `plan-proceed` の確かめをし、当たれば表が「脇に置く」のままでも選び直して implement に進める（`fleet-status` は `plan-proceed` を読まない）。
- PR が無い段階の Issue は、既に選んだ Issue・PR 段階・実装中の Issue と計画の files が重なれば待つ。重なりの相手にする着手宣言は、ほかのセッションの解除されていない宣言と、このセッションの実装中（段階 `implement`）の宣言だけ。このセッションのほかの段階（plan・plan-gate など）の宣言どうしで重なれば、並べた順の先の側を選び、後の側が待つ（入れ子の方式では ship が全部このセッションの ID で宣言するため）。
- 既に選んだ Issue のうち段階が `plan-review`（人の判断待ち）のものは、ほかの Issue の重なりの相手にしない（今は進まないので、進められる Issue を待たせない）。`plan-review` の Issue 自身は、PR 段階・実装中の Issue と重なれば待つ。人が進めると決めた後は、手順3で読み直した表で改めて重なりを判定し、相手が既に実装中（`implement` の宣言）ならその Issue が待つ。
- `harness.config.json` の `fleet.sharedFiles`（書かなければ空。このリポジトリの `harness.config.json` では `docs/plan.md`・`harness/docs/formats.md`・`harness/docs/operations.md`・`harness/docs/security.md`・`harness/docs/glossary.md` と `**/README.md`）だけで重なる組は待たせない（表の「重なり」列に「共有ファイルのみ（並行可）」と出る）。
- 両方に PR がある組は、`fleet-status` が PR の head を fetch して `git merge-tree` で実際に試し、衝突する組だけ、並べた順の後の側が待つ。衝突しなければ、同じファイルを変えていても並行して進める。
- `git merge-tree --write-tree` が使えない環境（git 2.38 未満）や fetch に失敗したときは、PR 同士が全部「衝突」扱いになる（表のメモに「試せなかったため衝突ありとして扱う」と出る）。

## 手順

1. `node harness/scripts/agent.ts fleet-status`（対象を指定されたら番号も、本数を絞るなら `--max <n>` も渡す）で表を出し、「選ぶ」の Issue を控える。以降は同じ番号を渡して表を読み直す。選べる Issue が無ければ、待つ理由を添えて人に返す。表の末尾の「進め方」の行が入れ子（orca）なら、この手順1の宣言の扱いを守ったまま「入れ子の方式」の節で進め、交互（flat）なら手順2〜5で進める。ただし `node harness/scripts/panes.ts config` の `shipMode` が `worker` なら、先に節「Orca の worker で ship を動かすとき」の 1 で Orca の有無を確かめ、あればその節で進める。`fleet-status` が `harness.config.json` の `fleet` の誤りで止まったら、人に返す（方式を推測で選ばない）。
   - このセッションの着手宣言（宣言の session が今のセッションの ID と同じ）は選ばれ、メモに段階が出る。PR の無い段階は Issue の宣言を、PR の段階は PR の宣言（`claim <PR番号> --stage judge|fix|sync`）を見る（メモには「PR の着手宣言」と出る）。「着手宣言あり」で選ばれない Issue が止まった前のセッションの途中のもの（`/clear` で ID が変わった場合を含む）なら、1件ずつ聞かずに、前のセッションごとに「前のセッション（session <短い ID>）の宣言 #…（N 件）をこのセッションに引き継ぐか」を AskUserQuestion の1問でまとめて聞く（おすすめは引き継ぐ。Orca の worker のときは hq に `ask` の1問）。引き継ぐなら全部を `node harness/scripts/agent.ts claim <番号> --manual --takeover` で出し直して読み直す（PR の段階なら `claim <PR番号> --manual --stage judge|fix|sync --takeover`）。拒まれたら出し直さない。
   - Issue に手を付ける最初に、ship と同じく `claim <番号> --manual --stage <段階>` で宣言する。人の判断待ちで止めてセッションを終えるときは `release <番号>` で解除する。
   - `claim` が「先に宣言したセッションがある」で止まったら（同時に宣言して後の側になった。自分の宣言は取り下げ済み）、その Issue を飛ばして次の Issue へ進み、最後の一覧に「#番号 は session … が着手中」と載せる（引き継ぐかは人が決める）。
   - 着手宣言（`claim <番号> --manual`）が領域の上限で止まったら、`--fleet` を付けて宣言する（fleet は領域の上限を見ないため）。
2. 「選ぶ」の Issue ごとに（選択が「待つ」の行は、次にやること（fix・judge など）が出ていても進めない）、表の「次にやること」の段階を ship と同じ判断（ship の手順2〜6）で1つ進める。
   - plan：plan の skill。批評（plan-critic）は Issue ごとに並行して呼んでよい。Planner の質問（`openQuestions`・`needsHumanReasons`）は plan の skill の手順3どおり投稿の前に AskUserQuestion で聞く（複数の Issue の質問を1回にまとめてよい。1回に4問まで）。入れ子の方式では ship が投稿せずに質問を返すので、「入れ子の方式」の手順2でまとめて聞き、答えを渡して ship を呼び直す。計画ゲートが `agent:plan-review` で止めた Issue は、auto mode の Jev の保留なら先に節「auto mode の保留の検討会」を（開くかは聞かずに）行い、そうでなければ ship の手順2と同じく、宣言が残っていれば `release <番号>` で解除してから、ship の手順2の `plan-proceed` の確かめをし、当たれば聞かない。当たらなければ、進めてよいかを聞く（手順9でまとめて聞いてよい）。Planner の申告で止まったら、ship の手順2どおり人の答えを `post-decision` で記録する。人が「進める」と答えたら、plan の skill の手順10どおり、その言葉を進める記録（`agent-decision` の `proceed`、`post-decision`）で残してから implement に進める（入れ子の方式では、答えを渡して呼び直した ship が記録する）。
   - implement：implement の skill。worktree は Issue ごとに分ける。test-designer・実装は並行してよい。
   - judge：judge の skill。Reviewer・Risk Agent は Issue ごとに並行して呼んでよい。
   - fix：fix の skill。
   - 確認事項の答えがそろった行（次にやることが `resume` の段階）は、その段階の skill を `step <番号>` が出した `claim` で宣言し直して続け、`inputs` の先頭の人の答えを根拠にする。答えのコメントは書かない。
   - sync：sync の skill。
   - 「—」（待つ）：計画ゲート・判定の受け付け・App の Merge 経路を待つ。ほかの Issue を先に進める。
3. 段階を1つ進めるたびに、手順1の `node harness/scripts/agent.ts fleet-status` を読み直して、次にやることを決める。セッションの記憶に頼らない（止まっても同じ手順で続きから再開できる）。
   - 計画の後に「触るファイルが重なるため待つ」になった Issue は、実装に進めない（先に選んだほうの Merge の後に読み直す）。
   - PR 同士が衝突して待つ Issue は、先の側が Merge された後に sync の skill で main を取り込んでから進める。
   - `--max` の本数で待つ Issue は、ほかが Merge されるまで進めない。
   - 脇に置いた行（人の判断待ちが `hq.humanWaitMinutes` を超えた Issue・PR の止まる印）は進めない。表の下の「脇に置いた人の判断待ちの、このセッションの着手宣言：…（release する）」の行（`--json` の `setAsideReleases`）の番号を、それぞれ `release <番号>` で解除する（PR 番号もそのまま渡す）。脇に置いた Issue は AskUserQuestion・hq への `ask` で聞き直さない（既に聞いたものを繰り返さない）。
4. Merge 済みの Issue が出たら、次にやることが sync になった残りの PR に sync の skill をする（判定が引き継がれたかを確かめ、変わっていれば判定し直す）。
5. 「選ぶ」の Issue が全部、人の Merge 待ち（Ready・人の Merge 待ち、自動 Merge 待ち）か人の判断待ち（plan-review、止まる印あり、各 skill の人に返す条件）になるまで、手順2〜4を繰り返す。その後、手順6〜9で一覧を出し、人の判断待ちだけが残ったのでなければ、終わらずに節「待つ間の読み直し」へ進む。
6. ラベル（`priority:*`・`area:*`）は、ship の手順8と同じく、まず Jev に任せ、App の名義の `kind=label-triage` の記録の `notApplied` がまだ足りなければ、本文と Jev の提案を見て決めて付け、付けたラベルと理由を Issue のコメントに残す（`node harness/scripts/agent.ts label-fill` で付ける。`gh issue edit` は使わない）。記録が無ければ付けない。人や App が付けたラベル・`type:*`・違反は変えない。不足や違反を手順9の一覧に書かず、人にも聞かない。
7. `node harness/scripts/agent.ts usage` で、このセッションのトークン数と推定料金を読む（入れ子の方式の ship とその中の担当の記録も、このセッションの `subagents/` に置かれるので集計に入る）。費用の行には、呼び出しの回数 `calls` と1回あたりのキャッシュの読み込み量 `cacheReadPerCall` も書く（段階ごとに新しく呼ぶ前後の比べに使う）。
8. 振り分け：ship の手順9と同じ振り分けを、Issue をまたいで1回行う（`node harness/scripts/agent.ts incident list` で記録を読み、入れ子の方式の ship は fleet と同じセッション ID なので同じ記録に入る。Issue の候補は `node harness/scripts/agent.ts rest issue-search <要点の語>...` で開いた Issue と照らし、無ければ `node harness/scripts/agent.ts incident render-issue <id>... --title <題>` で下書きを作る）。複数の Issue で同じ問題が出たら1つの候補にまとめる。起票・コメントは人が選んだものだけで、自動で起票しない。人が選んで起票した Issue のラベルは手順6と同じく Jev に任せる。
9. 人に**人がすること**の一覧を1つにまとめて出す（Issue・PR ごとに ship の手順10と同じ項目）。ship が返した「決めたこと（覆すなら）」（聞かずに決めて `post-judgment` で残した「セッションの判定」）も、Issue・PR ごとに一覧の項目にする（コメントへのリンク・決めたこと・当たった基準・覆し方）。
   - Merge：ship の手順6の分け方（App の記録）に従う。人の Merge 待ち（`kind=human-review` のコメントの PR。Merge の順番に意味があれば順番も）。自動 Merge 待ち（auto-merge が付いた、または `kind=bypass-merge`・`delegated-merge`・`auto-mode-merge` の記録で最新が `-end` でない）は何もしない（`agent:hold` を頼むのは、持ち主がその Issue で「Merge は自分でする」と明示したときだけ）
   - 例外ラベル：`test:exempt` は自動 Merge の対象の PR で `agent/tests` が failure のときだけ（Human Merge の PR では付けず、依頼のコメントに載ったテストの変更を Merge の前に確かめる、を「Merge」の項に書く）。`review:exempt` は付けるかの判断。どちらも、その理由を書いた場所
   - `node harness/scripts/setup.ts` の実行が要る変更か
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - 人の判断待ち：脇に置いた Issue は「#番号 人の判断待ち N 分：<決めてほしいこと>」の1行で書く（PR の止まる印は「時間は読まない」。聞き直さない）。どの Issue の、どの段階の、何を決めてほしいか。一覧を出した後に AskUserQuestion でまとめて聞く（1回に4問まで。聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）。入れ子の方式の投稿の前の質問で答えが無いまま終える Issue は、`release <番号>` で解除してから「計画は投稿していない」と書く。聞いた答えを ship に渡して記録させるときも、決定のコメントにセッションの言葉で Merge の経路を書かない（経路は App が決める）
   - 確認事項の答え待ち：Issue / PR ごとに「#番号 確認事項の答え待ち（確認事項の URL）：聞いたこと」。表の「待つ：確認事項の答え待ち」の行も載せる（呼ばない）。答えは手元のダッシュボードか確認事項のコメントへの `/answer`（セッションは代わりに書かない）
   - 待たせた Issue と理由（重なり・PR 同士の衝突・`--max` の本数）
   - 宣言で負けて飛ばした Issue：「#番号 は session … が着手中」
   - 費用：進めた本数と、手順7のトークン数・推定料金
   - 改善の候補：手順8の Issue の候補（題と下書きの本文のファイルのパス）と、開いた Issue へのコメントの案・docs の候補。起票・コメントは人が選んだものだけ（自動で起票しない）。候補が無ければ「改善の候補はありません」と書く

## 入れ子の方式（orca）

表の「進め方」の行が入れ子（orca）のときの、手順2〜5の代わり。手順1・6〜8と「選び方」はそのまま使う。

1. 表の「選ぶ」の Issue ごとに、ship の skill を general-purpose のサブエージェントで呼ぶ。ship は Issue ごと・段階ごとに新しいサブエージェントで呼び、前の ship を SendMessage で続けない（1回の呼び出しで1段階だけ進め、引き継ぎを返す）。同時に動かすのは、表の「同時に動かす ship は <n> まで」の数まで（`--max` があれば `--max`、無ければ `fleet.maxParallelShips`）。残りは、1つ返るたびに表を読み直してから呼ぶ。
   - 渡すもの：Issue 番号、段階、その Issue の最後の引き継ぎ（`agent-handoff`）のファイルのパス（あれば）、「サブエージェントの ship として動く（ship の skill の「サブエージェントの ship として動くとき」の節に従う）」こと、fleet が `fleet-status` に渡した Issue 番号の集合と `--max`（ship が同じ引数で表を読むため）、呼び直すときは人の判断への答え（投稿の前の質問なら、その答えと、ship が返した書きかけの計画のパスも）。計画ゲートの記録の `autoMode.hold` が真、または受け付けの `autoMode.reasons` に Jev の保留があれば、検討会を開かず、`plan-review-check` の `riskOnly` が真でも聞かずに進めると決めず、`node harness/scripts/agent.ts release <番号>` してから「Jev の保留」として返すよう伝える。
   - 段階の決め方：(a) 表の「次にやること」が `plan`・`implement`・`judge`・`fix`・`sync` なら同じ名前の段階で呼ぶ（`none` なら呼ばない。引き継ぎの `next` と表が食い違えば表に従う）。(b) 表の下の「Merge 後の見届けが済んでいない」の行が出たら、段階 `merged` で呼ぶ。(c) 表の行のメモが確認事項の答えで、次にやることが `resume` の段階（`none` でなくなった行）なら、その段階で「確認事項の答えで再開」と渡して呼ぶ（ship は `step <番号>` の `inputs` の人の答えで進める）。(d) 人の判断・投稿の前の質問への答えを渡す呼び直しは、返った引き継ぎの `stage` と同じ段階で、そのファイルのパスと答えを渡す。(a)(b) では最後の引き継ぎのファイルがあれば渡す（無ければ渡さない。新しい ship は GitHub の事実から読む）。
   - worktree は ship が Issue ごとに作る。1つの worktree を複数の ship で共有しない。
   - 着手宣言は ship がこのセッションの ID で出す（入れ子のサブエージェントにも `AGENT_HARNESS_SESSION` が同じ値で渡るので、`critic-input`・`post-plan`・`worktree` は止まらない）。
2. ship が返したら、その結果（引き継ぎ・状態・人に聞くこと・人がすることの項目・待つ理由）を控え、`fleet-status` を読み直して次を決める。セッションの記憶に頼らない。返った引き継ぎの `status` が `continue` なら、表を読み直して (a) で次の段階の ship を新しく呼ぶ。ほかの `status` は次の扱いのとおり。
   - 「入れ子不可」：Agent ツールが無く ship の中でサブエージェントを呼べない。以降はこのセッションで交互の方式（手順2〜5）に切り替える。
   - 人の判断待ち：人に上げる場面（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）だけ。聞かずに決めてよい場面は ship が決めて `post-judgment` で残しているので、ここでは聞かない。手順9の前でも、たまったらまとめて AskUserQuestion で聞いてよい（1回に4問まで。質問ごとに「なぜ人が要るか」を1行で添える）。答えを渡して、その Issue の ship を呼び直す。人が拒んだ・答えなかったら、その Issue は人の判断待ちのまま一覧に書く。
   - 確認事項（人の判断待ちのうち、規則の確認事項の (a) ほかに進められる Issue がある、または (b) 人がその場にいない、に当たるもの）：AskUserQuestion の代わりに、ship が返した質問と段階で確認事項のファイルを書き、`node harness/scripts/agent.ts check <ファイル>` の後に `node harness/scripts/agent.ts post-confirm <番号> <ファイル>` で投稿して（`stage` は返った段階、`resume` は答えの後に再開する段階。番号は plan・plan-critique・implement は Issue、judge・fix・sync は PR）、`release <番号>` してほかの Issue を進める。手順9の一覧の「確認事項の答え待ち」に載せる。hq の worker として動く fleet は今どおり hq に `ask` する。`agent:plan-review`・Planner の質問・引き継ぎ・Jev の保留・修正の上限は確認事項にしない。答えのコメントは書かない。
   - 投稿の前の質問（ship が計画を投稿せずに返した Planner の質問）：ship の宣言が `plan` のまま残っているので、手順9を待たずに、返った質問を複数の Issue の分もまとめて AskUserQuestion で聞く（1回に4問まで。残りは次の回。おすすめを先頭）。答えと、ship が返した書きかけの計画のパスを渡して、その Issue の ship を呼び直す。人が拒んだ・答えなかった質問は「答え無し」として渡して呼び直す（ship は申告を残して投稿し、`post-plan` が宣言を解除する。同じ質問を繰り返さない）。聞けないまま、または呼び直せないままセッションを終えるときは、その Issue を `node harness/scripts/agent.ts release <番号>` で解除し、手順9の一覧に「投稿の前の質問に答えが無く、計画は投稿していない（次は plan から）」と書く。
   - Jev の保留：節「auto mode の保留の検討会」で3つの担当に調べさせ、結論を出す（開くかは聞かない）。
   - 待つ（重なり・PR 同士の衝突・`--max` の本数・領域の上限）：表で「選ぶ」に戻るまで呼び直さない。領域の上限で待つ Issue は、fleet が `claim <番号> --manual --stage implement --fleet` で宣言し直してから呼び直してよい（fleet は領域の上限を見ないため）。
   - Merge 済みの Issue が出たら、次にやることが sync になった残りの PR の ship を呼び直す。
3. 「選ぶ」の Issue が全部、人の Merge 待ちか人の判断待ちになるまで、1〜2を繰り返す。その後、手順6〜9に進み（手順9の一覧は、ship が返した人がすることの項目をまとめる）、人の判断待ちだけが残ったのでなければ、終わらずに節「待つ間の読み直し」へ進む。

## auto mode の保留の検討会

この節の中身は [references/hold-council.md](references/hold-council.md)。auto mode の Jev の保留（計画ゲートの記録の `autoMode.hold`、PR の受け付けの `autoMode.reasons`）を見つけたときに読む。

## Orca の worker で ship を動かすとき

この節の中身は [references/orca-ship-worker.md](references/orca-ship-worker.md)。`fleet.shipMode` が `worker` で Orca があるときに読む。

## Orca の worker として動くとき

この節の中身は [references/as-worker.md](references/as-worker.md)。hq に Orca の worker として起こされたとき（プロンプトに orchestration の注入の前置きがある）に読む。

## ハーネスが更新されたときの交代

この節の中身は [references/handover.md](references/handover.md)。`fleet-status` に「読み込みは古い」の行が出たときに読む。

## 待つ間の読み直し

App の計画ゲート・判定の受け付け・自動 Merge・CI を待つ間も、fleet が見る。

1. **いつ**：選んだ Issue が全部「待つ」（App・CI 待ち）か人の Merge 待ち（`human-merge`・`auto-merge`）になったら、手順9の一覧を出した後も終わらずに、表の下の間隔（`harness.config.json` の `fleet.watch.intervalMinutes`、既定 3 分）ごとに `node harness/scripts/agent.ts fleet-status --watch <番号>...` を読み直す。待ち方は付き添いのセッションの中の道具（Bash の `run_in_background` の until ループ・Monitor など）で、schedule・Actions・クラウドの Routine は使わない。
   - クラウドの付き添いのセッション（`CLAUDE_CODE_REMOTE` が `true`）では、ship の節「クラウドで PR を出した後（PR のイベントで進める）」で購読した PR の行を、この間隔の読み直しから外す（その行は PR のイベントと30分おきの見回りで進める）。待っている行が全部購読中の PR なら、until ループ・Monitor で待たずにターンを終える（取りこぼしに備える `send_later` の見回りは、上の「schedule・Actions・クラウドの Routine は使わない」の例外として ship の節のとおり使う）。購読していない行（購読できなかった・PR の無い計画ゲート待ちなど）だけ読み直す。下の 6 の「App が動いていない」の行は、起きたときに読む `fleet-status` で見る。
2. **交代の行もここで見る**：読み直すたびに、表の下の「このセッションの読み込みは古い」の行も見る（節「ハーネスが更新されたときの交代」）。
3. **ship を呼び直す**：次にやることが出たら（plan-ok・fix・judge（判定のやり直し）など。`plan-review` の行にship の手順2の `plan-proceed` の確かめが当たったら（段階 implement）も）、または表の下の「Merge 後の見届けが済んでいない」の行（Issue が開いている・`claude/issue-<番号>-` の worktree が残る。見張りの記録に頼らず事実で見分けるので、最初の読み直しでも交代の後の新しい fleet でも出る）が出たら、その Issue の ship を、入れ子の方式の手順1の (a)(b) の段階で新しいサブエージェントとして呼び直す（次にやることは (a)、見届けの行は (b)。Merge の後は ship が Merge 後の確かめ・worktree の片付け・Close の見届けをする）。確認事項の答えがそろい、次にやることが `resume` の段階になった行も、その段階で「確認事項の答えで再開」と渡して呼び直す。
4. **「Close されていない」の扱い**：このセッションで既に呼び直して ship が「Close されていない（理由）」で返した Issue は、人の判断待ちとして手順9の一覧に載せ、同じ行が出続けても呼び直さない。この印はセッションの中で持ち、見張りの記録には残さない。交代の後の新しい fleet は最初の1回だけ呼び直す。終わり方の「人の判断待ちだけが残った」でもこの Issue を人の判断待ちに数える。
5. **自分の PR の sync**：自分の行（`fleet-status` に渡した Issue の PR）の次にやることが `sync` になったら、`human-merge`・`auto-merge` の段階でも、その Issue の ship を (a) の段階 `sync` で新しいサブエージェントとして呼び直して sync させる。fleet 自身は衝突を直さない（直すのは ship）。ほかのセッション・持ち主のいない PR は対象にしない。
6. **App が動かないとき**：表の下に「App が動いていない」の行（`fleet.watch.appStallMinutes`、既定 20 分以上、計画ゲートの記録が付かない・auto-merge が付いたまま Merge されない）が出たら、人に知らせる（付き添いでは文章で。Orca の worker のときは節「Orca の worker として動くとき」のとおり hq に `escalation`）。同じ行を知らせるのは1回だけで、その後も読み直しを続ける。
7. **終える**：読み直しを終えるのは、受け持つ Epic が Close し、かつ hq が足した Epic の外の Issue が全部 Merge 済み（見届け済み）か人の判断待ちになったとき（`node harness/scripts/agent.ts rest issue-view <Epic番号>` の `state`。その後に手順6〜9の最後の一覧を出す。足された Epic の外の Issue が残る間は終えない）と、人の判断待ち（`plan-review`・止まる印・各 skill の人に返す条件・上の 4。`hq.humanWaitMinutes` を超えて脇に置いた Issue も含む）だけが残ったとき。受け持つ Epic が無い fleet は、選んだ Issue が全部 Merge 済み（見届け済み）か人の判断待ちになったとき。受け持ちが全部、人の判断待ち（脇に置いたものを含む）になったら「今は進められない（人の判断待ちが `hq.humanWaitMinutes` を超えた）」として終える。Orca の worker なら `worker_done` のレポートの先頭にそう書く。

## 終わりの状態

- 受け持つ Epic が Close した（Epic が無い fleet は、選んだ Issue が全部 Merge 済み（見届け済み）か人の判断待ちになった）か、人の判断待ちだけが残っている（脇に置いた Issue を含む）（`node harness/scripts/agent.ts fleet-status --watch` の表で確かめた）。人の Merge 待ち・App 待ちが残る間は終わらず、節「待つ間の読み直し」を続ける。
- 人がすることの一覧（トークン数・推定料金・改善の候補を含む）を出した。
- 続けて使わない worktree は `node harness/scripts/agent.ts worktree-remove <ブランチ>` で消した。

## 人に返す条件

途中で人に返すとき（下のどれに当たったときも）も、手順8の振り分けをして改善の候補を示してから返す。

- ship の「人に返す条件」に当たった（その Issue は止めて人に返し、ほかの Issue は進める。一覧にまとめて返す）
- 確認事項を書いて `release <番号>` した Issue（答えが来るまで進めず、一覧の「確認事項の答え待ち」に載せ、ほかの Issue は進める）
- 選べる Issue が無い（止まる印・依存・着手宣言・重なり・PR 同士の衝突・`--max` の本数で全部が待つ）
- 選んだ Issue が全部待つ状態になり、人の判断待ちだけが残った（App・CI 待ち・人の Merge 待ちが残る間は人に返さず、節「待つ間の読み直し」を続ける）
- 交代できない（Orca も起動の手段（tmux）も無い・本体を追いつかせられない・交代の後に `auto mode` を確かめられない。節「ハーネスが更新されたときの交代」の 4・5）
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge`・auto mode のラベル（既定 `agent:auto-mode`。名前は `harness.config.json` の `autoMode.label`）と `*:exempt` のラベルの付け外し
