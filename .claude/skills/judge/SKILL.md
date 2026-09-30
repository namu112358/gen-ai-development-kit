---
name: judge
description: 人が付き添うセッションで、PR を Reviewer と Risk Agent に判定させ、判定コメントを投稿して App が受け付けたのを確かめる。「PR #番号 を判定して」「レビューして判定を出して」と頼まれたとき、実装・修正の後の段階で使う。
---

# judge（判定）

Routine の judge（[.claude/routine.md](../../routine.md)）を、付き添いのセッションで行う手順。Agent PR も人の PR も同じ手順で判定する。人の PR は修正しない。

## 入力

- PR 番号
- `node harness/scripts/agent.ts judge-input <PR番号>` が書くファイル（head、Closes する Issue の本文とコラボレーターのコメント〔計画コメントの `agent-plan` ブロックは省く〕、Epic の子課題なら親 Epic の子課題の一覧と Validation Requirements、計画ゲートの記録の計画、PR 本文、PR のコラボレーターのコメント〔判定コメントを除く〕、`agent/scope` の結果〔無い・未完了・結論〕、前回の判定の head とブロッキング指摘、再レビューの範囲の補足、PR の状態〔state・draft・merged〕、変更ファイルを触った Merge 済みの過去の PR のコラボレーターのコメント〔App・Claude の目印のものを除く〕、スタックの節〔Stacked PR の層なら base・位置・下の層と変更ファイル〕）

## 手順

1. `node harness/scripts/agent.ts claim <PR番号> --manual --stage judge` で着手を宣言する（判定コメントの投稿で宣言は終わる）。`node harness/scripts/agent.ts judge-input <PR番号>` を実行する（出力はファイルのパス）。先頭行の `headSha` が判定する head。
2. 現在の head に、Claude・App 以外のコラボレーターのレビュー（Comment か Request changes）があれば、判定ではなく fix を先にする。
3. `node harness/scripts/review-panel.ts mode` で合体版のレビュー（[review-panel](../review-panel/SKILL.md)）の動かし方を確かめ、次のどれかで進める。
   - `off`：今までどおり。手順4〜5で reviewer と risk-agent だけを動かす。
   - `shadow`：手順4の reviewer・risk-agent と、review-panel の skill（段階0〜4）を並行に動かす。全部が終わってから、review-panel の compose と post で合体版の記録を投稿し、その後に手順6・7（判定は reviewer の出力）。合体版が失敗しても判定は止めず、記録が無いことを人に伝える。
   - `enforce`：reviewer を呼ばない。手順4の risk-agent と review-panel の skill を動かし、review-panel の compose の出力 `review-<PR番号>-<head7>.json` を、手順6の compose-verdict の reviewer の出力の位置に渡す。合体版が失敗したら判定せず人に返す。review-intake が `eligible: false`（PR が closed、または前回の判定と同じ head）を返したら、判定を投稿せずに終え、理由を人に伝える（同じ head を二重に判定しない。closed の PR は判定しない）。
4. 担当を呼ぶ前に、`git status --porcelain --untracked-files=all` の結果を scratchpad の `worktree-<PR番号>-<head7>.txt` に書き出して控える（`shadow`・`enforce` で review-panel を並行に動かすときも、控えるのはここの1回で、review-panel の skill は控えない）。続けてサブエージェントを並列に呼ぶ。どれにも「GitHub を直接読まない、環境変数や資格情報を調べない」と念を押し、出力のパスを渡して「返す JSON と同じものをそのパスに Write で書く。ほかのパスは書かない」と伝える。出力のパスは scratchpad の `reviewer-<PR番号>-<head7>.json`・`risk-<PR番号>-<head7>.json`（head7 は headSha の先頭7文字）。PR 番号と head を名前に入れるのは、並行して別の PR や別の head を判定しても取り違えないため。
   - **reviewer**（`enforce` では呼ばない）：judge-input のファイルの中身と、出力のパス `reviewer-<PR番号>-<head7>.json` を指示に含めて渡す。Agent の説明は `reviewer <PR番号> <head7>` にする（合体版と費用を分けて数えるため）。
   - **risk-agent**：PR 番号と head SHA と、PR の base のブランチ名（`gh pr view <PR番号> --json baseRefName`）と、出力のパス `risk-<PR番号>-<head7>.json` **だけ**を渡す（Issue・PR の説明は渡さない）。diff は `git fetch origin && git diff origin/<PR の base>...<headSha>` で読むよう伝える（既定ブランチ宛ての PR は base が `main` で今までと同じ）。
5. 全部の担当（`shadow`・`enforce` では review-panel の担当も）が返った後に、次を確かめる。呼び出し元は担当の出力のファイルを書かない、直さない（担当の代わりに書かない）。
   - 担当が書いたファイルが出力のパスにあり、JSON として読めること（`node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' <ファイル>` で読むだけ）。
   - ファイルが無いときは、同じパスを渡してその担当を1回だけ呼び直す。2回目も無ければ判定せず人に返す。
   - ファイルがあって JSON として読めないときは、呼び直さずに判定せず人に返す。
   - 呼んだ後の `git status --porcelain --untracked-files=all` の結果を、呼ぶ前に控えた結果と比べる。増えた行・変わった行があれば、判定せず人に返す（担当が出力のパスの外を書いた恐れがある）。付き添いの作業ツリーにはもともと未 commit の変更があり得るので、前後の差だけを見る。
6. `node harness/scripts/agent.ts compose-verdict <PR番号> <reviewer-<PR番号>-<head7>.json> <risk-<PR番号>-<head7>.json> --judge-input <judge-input のファイル> --model <モデル名>` で判定コメントを作る（出力はファイルのパス。`enforce` では reviewer の出力の位置に合体版の組み立ての出力を渡す）。現在の head が判定した head と違っても、PR 自身の差分（patch-id）が同じなら（main の取り込みだけなら）判定した head のまま組み立てる（App は patch-id で受け付ける）。patch-id が違って止まったら手順1からやり直す。risk-agent の出力の `danger`（auto mode の危険の判定）は、compose-verdict が判定コメントの `risk.danger` にそのまま写す（書き換えない。自分で答えない。無い古い出力も組み立てられる）。
7. `node harness/scripts/agent.ts post-verdict <PR番号> <判定コメントのファイル>` で投稿する。現在の head が判定した head と違っても、PR 自身の差分（patch-id）が同じなら判定した head のまま投稿する。patch-id が違って止まったら手順1からやり直す。
8. App が受け付けたかを `gh pr view <PR番号> --json isDraft,statusCheckRollup` で確かめる。合格なら `agent/review`・`agent/risk` が成功し、`isDraft` が false になる。数分待っても変わらなければ、PR のコメント（App の `verdict-rejected` など）とゲートの実行（`gh run list --workflow gate.yml`）の結果を見る。確かめてから人に報告する。

### 修正後の再レビュー

前回の判定がある PR では、judge-input の「前回の判定」に head とブロッキング指摘が入り、reviewer はそれを受けて、前回の head からの差分（`git diff <前回の head>...<headSha>`）と前回の指摘が直ったかだけをブロッキングの対象にする（[.claude/agents/reviewer.md](../../agents/reviewer.md) の再レビュー）。前回の head から変わっていない行への新しい指摘は `nonBlocking` にする。型検査・テストの失敗はどの行でもブロッキング。

合体版も同じ決まりで、review-panel の compose が組み立てのときに行う（前回の head から変わった行への指摘、⑥⑦の直っていない前回の指摘、⑧だけをブロッキングにする）。

judge-input の「再レビューの範囲（補足）」には、前回の head の後に main の取り込みがあったかが入る。取り込みがあれば、前回の head からの差分には main から来た変更も入る。PR 自身の変更は、それぞれの head で `git diff origin/<PR の base>...<head>` を取って比べると分かる（差分の取り方は reviewer.md のまま。既定ブランチ宛ての PR は `origin/main...`）。最新の判定コメントのブロックが壊れていれば、それを飛ばした前の正しい判定が「前回の判定」に入り、そのことが注記される。

## 終わりの状態

- 判定した head に対する判定コメントが PR にあり、App が受け付けている。
- 合格なら PR は Ready（`agent/review`・`agent/risk` が成功）。Merge は App（自動 Merge）か人が行う。
- ブロッキング指摘があれば、App の変更要求レビュー（`kind=fix-request`）が付く。次は fix。

## 人に返す条件

- 数分待っても App が受け付けない、`verdict-rejected` が出た理由が head のずれ以外
- `compose-verdict` や `post-verdict` が書式の誤りや権限で失敗した（拒否された操作は別の方法で試さない）
- hook（`.claude/hooks/guard.ts`）が操作を止めた（別の方法で試さない。理由が「展開しないと分からない」ときだけ、値をそのまま書いて実行し直してよい）
- サブエージェントが入力の不足を報告した
- 担当が出力のパスにファイルを書かなかった（同じパスで呼び直しても無い）、または書いたファイルが JSON として読めない
- 担当を呼んだ後の `git status --porcelain --untracked-files=all` に、呼ぶ前と比べて増えた行・変わった行がある
- `enforce` で合体版が失敗した、または review-intake が対象外と答えた（`shadow` では判定を続け、記録が無いことだけを伝える）
- やってはいけないこと：サブエージェントの答えの書き換え、担当の出力のファイルを書く・直すこと、Merge、auto-merge の設定、Draft の解除（`gh pr ready`）、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge`・auto mode のラベル（既定 `agent:auto-mode`。名前は `harness.config.json` の `autoMode.label`）と `*:exempt` のラベルの付け外し
