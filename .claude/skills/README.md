# .claude/skills/

付き添いのセッション（人が見ている Claude の作業）の手順。各ディレクトリの `SKILL.md` が1つの skill で、Claude は頼まれた内容に合う skill の手順に従う。ふだんは ship に Issue 番号を渡せば、ほかの skill を順につないで進める。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `arch-review/` | 人が付き添うセッションで、Merge 済みの PR をまとめて読み、Issue をまたぐ設計のずれ（重複・置き場所・docs との食い違い・コードの書き方）を見つけて、直す Issue の下書きを人に示す。 |  |
| `fix/` | 人が付き添うセッションで、Agent PR のブロッキング指摘（App の変更要求レビュー）や人のレビューを直して push し、判定をやり直す。 | ○ |
| `fleet/` | 人が付き添うセッションで、複数の Issue を選び、ship を Issue ごとにサブエージェントで並行に動かして（入れ子にできなければ ship の各段階を交互に進めて）、全部を人の Merge 待ちか人の判断待ちまで進める。 |  |
| `gh-stack/` | 人が付き添うセッションで、Stacked PR（層を重ねた PR）を組む・見る。 |  |
| `implement/` | 人が付き添うセッションで、計画ゲートを通った（または agent:plan-review で人が進めると決めた）Issue を実装し、Draft PR を出す。 |  |
| `judge/` | 人が付き添うセッションで、PR を Reviewer と Risk Agent に判定させ、判定コメントを投稿して App が受け付けたのを確かめる。 | ○ |
| `orca-cli/` | Operate Orca-managed worktrees, folder contexts, terminals, repos, automations, artifacts, skill sharing, worktree comments, and Orca's embedded browser through the `orca` CLI. Use when the user says "$orca-cli", "Orca worktree", "child worktree", "spawn codex/claude in a worktree", "read/wait/send Orca terminal", "handoff" / "handover" / "give this to another agent", "Orca browser", "orca artifacts", or "share skills". Prefer it over raw git worktree, ad hoc PTYs, or Computer Use when Orca state is involved. Use Computer Use only when a visible window needs GUI control that a CLI, filesystem, or API cannot do. |  |
| `orchestration/` | Coordinate supervised Orca workers: threaded messages, blocking ask/reply, task dispatch, worker_done/escalation waits, task DAGs, decision gates, coordinator loops, and decomposing work across agents. Use `orca-cli` for full ownership handoffs — "hand off", "handoff", "handover", "give this to another agent", "another worktree" — unless asked to supervise, monitor, or coordinate a DAG, and for terminal control, lightweight terminal prompts, shell commands, Orca worktree management, and reading or waiting on terminals. |  |
| `plan/` | 人が付き添うセッションで、Issue の計画を書き、plan-critic に批評させて投稿する。 | ○ |
| `qa-retro/` | 人が付き添うセッションで、Merge 済みの PR をまとめて振り返り、判定（risk・reviewer）と実際の結果（後追いの修正・revert）のずれ、テストの穴、不安定なテストを報告し、直す Issue の下書きを人に示す。 |  |
| `review-panel/` | 人が付き添うセッションの judge の中で、公式の code-review に沿った合体版のレビュー（担当を並行に動かし、指摘を採点して組み立てる）を動かし、記録のコメントを投稿する。 | ○ |
| `ship/` | 人が付き添うセッションで、Issue 番号を受け取り、plan → implement → judge → fix（必要なら sync）の skill をつないで、人の Merge 待ちか人の判断待ちまで進める。 | ○ |
| `sync/` | 人が付き添うセッションで、判定済みの PR に main を取り込んで衝突を解消し、判定が引き継がれたかを確かめる（変わっていれば判定し直す）。 | ○ |
| `test-prune/` | 人が付き添うセッションで、減らせるテスト（ほかのテストと重なる、文言を固定するだけ、確かめる対象が見えない）を根拠つきで探し、削除・統合・書き直しの案と、直す Issue の下書きを人に示す。 |  |
<!-- readme:generated end -->

各 skill のディレクトリには `SKILL.md` だけを置き、説明はこの README にまとめる。
