# .claude/skills/

付き添いのセッション（人が見ている Claude の作業）の手順。各ディレクトリの `SKILL.md` が1つの skill で、Claude は頼まれた内容に合う skill の手順に従う。ふだんは ship に Issue 番号を渡せば、ほかの skill を順につないで進める。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `arch-review/` | 人が付き添うセッションで、Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれ（重複・置き場所・docs との食い違い・コードの書き方）を見つけて、直す Issue の下書きを人に示す。 |  |
| `fix/` | 人が付き添うセッションで、Agent PR のブロッキング指摘（App の変更要求レビュー）や人のレビューを直して push し、判定をやり直す。 | ○ |
| `fleet/` | 人が付き添うセッションで、複数の Issue を選び、ship を Issue ごとにサブエージェントで並行に動かして（入れ子にできなければ ship の各段階を交互に進めて）、全部を人の Merge 待ちか人の判断待ちまで進める。 |  |
| `implement/` | 人が付き添うセッションで、計画ゲートを通った（または agent:plan-review で人が進めると決めた）Issue を実装し、Draft PR を出す。 |  |
| `judge/` | 人が付き添うセッションで、PR を Reviewer と Risk Agent に判定させ、判定コメントを投稿して App が受け付けたのを確かめる。 | ○ |
| `plan/` | 人が付き添うセッションで、Issue の計画を書き、plan-critic に批評させて投稿する。 | ○ |
| `review-panel/` | 人が付き添うセッションの judge の中で、公式の code-review に沿った合体版のレビュー（担当を並行に動かし、指摘を採点して組み立てる）を動かし、記録のコメントを投稿する。 | ○ |
| `ship/` | 人が付き添うセッションで、Issue 番号を受け取り、plan → implement → judge → fix（必要なら sync）の skill をつないで、人の Merge 待ちか人の判断待ちまで進める。 | ○ |
| `sync/` | 人が付き添うセッションで、判定済みの PR に main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる（変わっていれば判定し直す）。 | ○ |
<!-- readme:generated end -->

各 skill のディレクトリには `SKILL.md` だけを置き、説明はこの README にまとめる。
