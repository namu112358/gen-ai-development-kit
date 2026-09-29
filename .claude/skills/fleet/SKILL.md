---
name: fleet
description: 人が付き添うセッションで、複数の Issue を選び、ship の各段階を Issue ごとに交互に進めて、全部を人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを1つの一覧にする。「複数の Issue をまとめて進めて」「fleet で進めて」と頼まれたときに使う。
---

# fleet（複数の Issue を並行して進める）

ship（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）を、1つのセッションの中で複数の Issue について交互に進める手順。各段階の中身は ship と各 skill に従い、ここに写さない。ship の中でサブエージェントを呼ぶので、ship そのものをサブエージェントにして並べない。

## 入力

- 対象：Issue 番号の一覧（任意）。無ければ `agent:ready`・`agent:plan-ok`・`agent:plan-review` の開いた Issue と、`agent:*` の無い、コラボレーター（OWNER・MEMBER・COLLABORATOR）か App（Epic の子課題など）が立てた開いた Issue（作ったまま計画に進んでいないもの）から選ぶ（`harness/lib/fleet.ts` の `fleetTargets`）
- 複数の Issue を作る依頼（「〜を Issue にして進めて」）なら、ship の入力と同じ書き方で作り、作った番号を対象にして、人が「作るだけ」と言わない限り同じセッションで plan から fleet を続ける
- 本数（任意）：衝突しない範囲で本数を制限せずに進める。本数を絞りたいときだけ `--max <n>` を渡す
- 状態の表：`node harness/scripts/agent.ts fleet-status [--max <n>] [<Issue 番号>...]` の出力（Issue・PR ごとの段階、次にやること、選ぶか・待つ理由、重なり）

## 選び方

- 領域の上限（`areaConcurrency`）は fleet では見ない。
- PR が無い段階の Issue は、既に選んだ Issue・PR 段階・実装中の Issue と計画の files が重なれば待つ。
- 両方に PR がある組は、`fleet-status` が PR の head を fetch して `git merge-tree` で実際に試し、衝突する組だけ、並べた順の後の側が待つ。衝突しなければ、同じファイルを変えていても並行して進める。
- `git merge-tree --write-tree` が使えない環境（git 2.38 未満）や fetch に失敗したときは、PR 同士が全部「衝突」扱いになる（表のメモに「試せなかったため衝突ありとして扱う」と出る）。

## 手順

1. `node harness/scripts/agent.ts fleet-status`（対象を指定されたら番号も、本数を絞るなら `--max <n>` も渡す）で表を出し、「選ぶ」の Issue を控える。以降は同じ番号を渡して表を読み直す。選べる Issue が無ければ、待つ理由を添えて人に返す。
   - このセッションの着手宣言（宣言の session が今のセッションの ID と同じ）は選ばれ、メモに段階が出る。PR の無い段階は Issue の宣言を、PR の段階は PR の宣言（`claim <PR番号> --stage judge|fix|sync`）を見る（メモには「PR の着手宣言」と出る）。「着手宣言あり」で選ばれない Issue が止まった前のセッションの途中のもの（`/clear` で ID が変わった場合を含む）なら、引き継ぐかを AskUserQuestion で人に確かめてから `node harness/scripts/agent.ts claim <番号> --manual --takeover` で引き継いで読み直す（PR の段階なら `claim <PR番号> --manual --stage judge|fix|sync --takeover`）。
   - Issue に手を付ける最初に、ship と同じく `claim <番号> --manual --stage <段階>` で宣言する。人の判断待ちで止めてセッションを終えるときは `release <番号>` で解除する。
   - `claim` が「先に宣言したセッションがある」で止まったら（同時に宣言して後の側になった。自分の宣言は取り下げ済み）、その Issue を飛ばして次の Issue へ進み、最後の一覧に「#番号 は session … が着手中」と載せる（引き継ぐかは人が決める）。
   - 着手宣言（`claim <番号> --manual`）が領域の上限で止まったら、`--force` を付けて宣言する（fleet は領域の上限を見ないため）。
2. 「選ぶ」の Issue ごとに（選択が「待つ」の行は、次にやること（fix・judge など）が出ていても進めない）、表の「次にやること」の段階を ship と同じ判断（ship の手順2〜6）で1つ進める。
   - plan：plan の skill。批評（plan-critic）は Issue ごとに並行して呼んでよい。計画ゲートが `agent:plan-review` で止めた Issue は、ship の手順2と同じく、宣言が残っていれば `release <番号>` で解除してから、進めてよいかを聞く（手順8でまとめて聞いてよい）。Planner の申告で止まったら、ship の手順2どおり人の答えを `post-decision` で記録する。
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
7. `node harness/scripts/agent.ts usage` で、このセッションのトークン数と推定料金を読む。
8. 人に**人がすること**の一覧を1つにまとめて出す（Issue・PR ごとに ship の手順9と同じ項目）。
   - Merge：Human Merge の PR（Merge の順番に意味があれば順番も）。自動 Merge なら何もしない（止めたければ `agent:hold`）
   - 例外ラベル：`test:exempt` は自動 Merge の対象の PR で `agent/tests` が failure のときだけ（Human Merge の PR では付けず、依頼のコメントに載ったテストの変更を Merge の前に確かめる、を「Merge」の項に書く）。`review:exempt` は付けるかの判断。どちらも、その理由を書いた場所
   - `node harness/scripts/setup.ts` の実行が要る変更か
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - 人の判断待ち：どの Issue の、どの段階の、何を決めてほしいか。一覧を出した後に AskUserQuestion でまとめて聞く（1回に4問まで。聞き方は [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方）
   - 待たせた Issue と理由（重なり・PR 同士の衝突・`--max` の本数）
   - 宣言で負けて飛ばした Issue：「#番号 は session … が着手中」
   - 費用：進めた本数と、手順7のトークン数・推定料金

## 終わりの状態

- 選んだ Issue が全部、人の Merge 待ちか人の判断待ちになっている（`node harness/scripts/agent.ts fleet-status` の表で確かめた）。
- 人がすることの一覧（トークン数・推定料金を含む）を出した。
- 続けて使わない worktree は `node harness/scripts/agent.ts worktree-remove <ブランチ>` で消した。

## 人に返す条件

- ship の「人に返す条件」に当たった（その Issue は止めて人に返し、ほかの Issue は進める。一覧にまとめて返す）
- 選べる Issue が無い（止まる印・依存・着手宣言・重なり・PR 同士の衝突・`--max` の本数で全部が待つ）
- 選んだ Issue が全部待つ状態になった
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-merge` と `*:exempt` のラベルの付け外し
