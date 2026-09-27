# .claude/skills/

付き添いのセッション（人が見ている Claude の作業）の手順。各ディレクトリの `SKILL.md` が1つの skill で、Claude は頼まれた内容に合う skill の手順に従う。ふだんは ship に Issue 番号を渡せば、ほかの skill を順につないで進める。

| 名前 | 内容 |
| --- | --- |
| `fix/` | fix：ブロッキング指摘や人のレビューを直して push し、判定をやり直す |
| `fleet/` | fleet：複数の Issue を選び、ship の各段階を Issue ごとに交互に進める |
| `implement/` | implement：計画ゲートを通った計画を実装し、Draft PR を出す |
| `judge/` | judge：Reviewer と Risk Agent に判定させ、判定コメントを投稿する。ガードレール |
| `plan/` | plan：計画を書き、plan-critic に批評させて投稿する。ガードレール |
| `ship/` | ship：Issue 番号から plan → implement → judge → fix（必要なら sync）をつなぎ、人の Merge 待ちか人の判断待ちまで進める |
| `sync/` | sync：判定済みの PR に main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる |

各 skill のディレクトリには `SKILL.md` だけを置き、説明はこの README にまとめる。
