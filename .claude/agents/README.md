# .claude/agents/

サブエージェント（Claude が作業の途中で呼び出す、役割と読む範囲を絞った別の Claude）の定義。各ファイルの先頭（frontmatter）の `name` と `description` で Claude Code が読み込む。この README には frontmatter が無いので、サブエージェントとしては読み込まれない。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `plan-critic.md` | 投稿前の計画を、Issue 本文と計画だけを見て批評し、go / revise / split / drop を構造化して返す。 | ○ |
| `reviewer.md` | Agent PR を Issue の AC・計画・diff と照らしてレビューし、ブロッキング指摘の有無を構造化して返す。 | ○ |
| `risk-agent.md` | PR の diff とリポジトリだけを見て、Risk ポリシーの8問に答える。 | ○ |
| `test-designer.md` | 実装の前に、Issue の AC と計画から検証用のテストを設計する。 | ○ |
<!-- readme:generated end -->
