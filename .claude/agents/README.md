# .claude/agents/

サブエージェント（Claude が作業の途中で呼び出す、役割と読む範囲を絞った別の Claude）の定義。各ファイルの先頭（frontmatter）の `name` と `description` で Claude Code が読み込む。この README には frontmatter が無いので、サブエージェントとしては読み込まれない。

| 名前 | 内容 |
| --- | --- |
| `plan-critic.md` | plan-critic：投稿前の計画を Issue 本文と計画だけで批評し、go / revise / split / drop を返す。ガードレール |
| `reviewer.md` | Reviewer：PR が AC を満たし、範囲を守り、既存の挙動を壊していないかを確かめ、ブロッキング指摘の有無を返す。ガードレール |
| `risk-agent.md` | Risk Agent：diff とリポジトリだけを見て Risk ポリシーの8問に答える（Issue 本文や PR の説明は読まない）。ガードレール |
| `test-designer.md` | test-designer：実装の前に、Issue の AC と計画から検証用のテストを書く。ガードレール |
