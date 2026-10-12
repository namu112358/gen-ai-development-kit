---
name: issue-creator
description: 気づき・観測を Issue Form の形の下書きにし、既存の Issue との重複を二段で確かめて JSON で返す（下書き）。呼び出し元が名指しした下書きだけを作る（作成）。intel などがサブエージェントで呼ぶ。人には聞かない。Issue の段階ではない。
---

# issue-creator（Issue の下書き・重複の確かめ・作成）

気づき・観測から Issue を作る手順を1つにまとめた skill（Issue #787）。役目は「下書き」と「作成」の2つで、呼び出し元（intel など）がサブエージェントで呼ぶ。人に見せるか・どう聞くか（一覧を示すだけか、AskUserQuestion か）は呼び出し元の skill が決め、この skill は人に聞かない。Issue の段階ではないので着手宣言は要らない。

重複の検索は二段にする：言い換えた語で候補を出し、候補の本文を読んで同じ根本の問題かを決める。検索の順位は候補を出すためだけに使い、決めるのは本文から読んだ理由（anthropics/claude-code の `/dedupe` と、重複チェックの MCP に倣った。#787 の Background）。

## 入力

- 役目：`draft`（下書き）か `create`（作成）
- 観測の本文と根拠（ファイルと行、Issue・PR・コメントの番号）。`create` では下書きのファイルのパス
- 出どころ：`from`（呼び出し元の役の名前。`intel`・`ship` など）と `ref`（呼び出し元の中の控えの ID。intel なら `M3` など）
- 書き出し先：scratchpad の下書きのパス（例：`draft-M3.md`）。結果の JSON はその後ろに `.json` を付けたパス

## 下書き

GitHub に書かない（読むだけ）。

1. 観測を Issue Form の形の下書きにして、渡されたパスに書く。書き方は [docs/operations.md](../../../docs/operations.md) の「Issue の書き方」に従う。
   - 見出しは Goal・Background・Requirements・Non-goals・Acceptance Criteria（と必要なら Dependencies・Validation Requirements）。Goal は人の言葉で1〜2文、Requirements は5つまで、AC は3つまで（`- [ ]` で1項目1条件）。1つの変更に絞る。ファイル名・行は Background の後ろに置く。AC に skill や docs の文のテストを入れない。
   - 題は Conventional Commits（`type(scope): 説明`）。
   - 本文の最後（最後の見出しの中身の後ろ）に、出どころの目印を1行置く：`<!-- agent-harness:issue-source from=<from> ref=<ref> -->`。
2. 重複の検索の1段目（候補を出す）：観測から言い換えを3〜5通り作る（症状・原因・触るファイルやコマンドの名前・日本語と英語）。言い換えごとに `gh issue list --state open --search "<語>"` と `gh issue list --state closed --limit 30 --search "<語>"`（最近閉じたもの。語ごとに30件まで）を流し、候補を10件までにまとめる。Epic #177・#186（incident の記録と振り分け）と重なるものは特に見る。`gh` が失敗したら候補なしとして進め、結果の `reason` にそう書く。
3. 2段目（決める）：候補の本文を `gh issue view <番号>` で読み、同じ根本の問題（同じ仕組み・同じファイル・同じ止まり方）かを決める。理由は本文から読んだ事実で書く。
4. `node harness/scripts/agent.ts issue-overlap check --title <題> --body-file <下書き> --session-duplicate <番号|none>` を流す（3で決めた同じ件の Issue の番号か none。GitHub に書かず、リポジトリの外の記録だけを書く）。鍵が無ければ skipped で止まらない。セッション ID が得られず fail したら飛ばして、3の判断のまま進める。
5. 結果を `<下書きのパス>.json` に Write で書き、同じ JSON を返す。

   ```json
   { "version": 1, "kind": "new", "title": "<題>", "draftPath": "<下書きのパス>",
     "target": null, "related": [], "reason": "<決めた理由1〜2文>",
     "overlap": "<issue-overlap check の提案の1行か skipped>",
     "source": { "from": "<from>", "ref": "<ref>" } }
   ```

   - `"kind"` は `new`・`comment`・`related` のどれか。
   - `comment`：同じ根本の問題の開いた Issue がある。`target` にその番号を書き、下書きはその Issue へのコメントの案（足すのは追加の根拠・再現・出どころだけ）に書き換える。
   - `related`：重なるが同じではない開いた Issue がある。下書きは新しい Issue のままで、`target` に一番近い番号、`related` にほかの番号を書く。
   - `new`：重なる開いた Issue が無い。閉じた Issue の再発や、範囲が広がるときも `new` にして `related` に番号を書く。

## 作成

呼び出し元が名指しした下書きだけを作る。

1. 作る前に、出どころの目印で二重を確かめる。`gh issue list --state all --search "agent-harness:issue-source from=<from> ref=<ref>" --json number,url,body` と `gh issue list --author @me --state all --limit 100 --json number,url,body` の本文に、同じ目印（`from` と `ref` が同じ）があれば作らずに、その URL を返す。見つけられるのはこの2つの範囲だけ（ほかの名義で作られ、検索にも当たらない古い Issue は見つからない）。
2. 下書きのファイルが無ければ作らずに、理由を返す。
3. 下書きの題と本文で `gh issue create --title "<題>" --body-file <下書き>` を1回だけ流し、作った Issue の URL を返す。ラベルを付けない（`--label` を渡さない。`agent:ready` も付けない。着手の許可は人が出す）。
4. 1回の呼び出しで作るのは1件。コメントの案（`"kind": "comment"`）はこの役目では投稿しない（投稿するかは呼び出し元の skill の決まりに従う）。

## してはいけないこと

- 下書きの役目で GitHub に書かない（Issue の作成・コメントの投稿・ラベル）。
- 名指しされていない下書きを作らない。
- 計画に進まない・着手宣言（claim・release）をしない。
- 人に質問しない（AskUserQuestion を使わない。聞くのは呼び出し元）。
- scratchpad の外のファイルを書かない。Issue 本文を書き換えない。
- 規則（[harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md)）の「やってはいけないこと」もそのまま守る。

## 呼び出し方

- 呼び出し元は Agent ツールの general-purpose に、この skill の節「下書き」か「作成」に従うことと、入力（役目・観測と根拠・出どころ・書き出し先）を渡す。モデルは `model: sonnet`（下書きと検索は文章の整理で、重なりの判定は `issue-overlap check` が別にする）。呼び出し元が待たないなら `run_in_background: true`。
- 返事の本文と結果のファイルが食い違ったら、ファイルを使う。結果のファイルが無い・JSON として読めないときは、同じ件で呼び直さず、呼び出し元が自分でこの skill の手順に従う。
- Agent ツールが無い（呼べない）ときも、呼び出し元が自分でこの skill の手順に従う。

## 終わりの状態

- 下書き：下書きのファイルと、結果の JSON（`<下書きのパス>.json`）がある。GitHub には何も書いていない。
- 作成：作った（か、目印で既にあった）Issue の URL を返した。作ったのは名指しされた1件だけで、ラベルは付けていない。
