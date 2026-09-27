# .claude/agents/

サブエージェント（Claude が作業の途中で呼び出す、役割と読む範囲を絞った別の Claude）の定義。各ファイルの先頭（frontmatter）の `name` と `description` で Claude Code が読み込む。この README には frontmatter が無いので、サブエージェントとしては読み込まれない。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `plan-critic.md` | 投稿前の計画を、Issue 本文と計画だけを見て批評し、go / revise / split / drop を構造化して返す。 | ○ |
| `review-ac-scope.md` | 合体版のレビューの段階3の観点⑥として、Issue の AC を満たしているか、範囲外の変更がないかを確かめ、指摘を返す。 | ○ |
| `review-intake.md` | 合体版のレビューの段階0〜2として、PR が対象か、関係する CLAUDE.md のパス、変更の要約を返す。 | ○ |
| `review-lens.md` | 合体版のレビューの段階3の観点①〜⑤（CLAUDE.md・明らかなバグ・履歴・過去の PR のコメント・コードのコメント）のうち、呼び出し元が指定した1つで diff を読み、指摘を返す。 | ○ |
| `review-safety.md` | 合体版のレビューの段階3の観点⑦として、秘密の漏えい・データ破壊・AC の外の退行を探し、指摘を返す。 | ○ |
| `review-scorer.md` | 合体版のレビューの段階4として、指摘1件が本当の問題か誤検知かの確信度を 0〜100 で返す。 | ○ |
| `reviewer.md` | Agent PR を Issue の AC・計画・diff と照らしてレビューし、ブロッキング指摘の有無を構造化して返す。 | ○ |
| `risk-agent.md` | PR の diff とリポジトリだけを見て、Risk ポリシーの8問に答える。 | ○ |
| `test-designer.md` | 実装の前に、Issue の AC と計画から検証用のテストを設計する。 | ○ |
<!-- readme:generated end -->
