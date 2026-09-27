# docs/upstream/

公式などの外部から写したファイルと、その出どころ・ライセンス。ここのファイルは書き換えない（Claude Code のコマンドや skill としては読み込まれない場所に置く）。元にして書いたこのリポジトリのファイルは、本文の「元：…。変えたこと：…」に写しのパスとコミットを書く。

## claude-plugins-official/

| 項目 | 内容 |
| --- | --- |
| リポジトリ | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) |
| コミット | `fa59bc9037741ecfa131aa27938272605710d7b2` |
| パス | `plugins/code-review/commands/code-review.md` → `claude-plugins-official/code-review.md` |
| ライセンス | Apache License 2.0。`claude-plugins-official/LICENSE` は同じコミットの `plugins/code-review/LICENSE`（プラグインのディレクトリにあったのでそれを写した。root の LICENSE ではない） |
| NOTICE | 同じコミットの `plugins/code-review/` と root に NOTICE は無い。このリポジトリの root の [NOTICE](../../NOTICE) に出どころを書いた |

写しを元にしたファイル（合体版のレビュー、[docs/review-panel.md](../review-panel.md)）：

| ファイル | 元にした部分 |
| --- | --- |
| `.claude/agents/review-intake.md` | 手順1〜3（対象か・CLAUDE.md のパス・要約） |
| `.claude/agents/review-lens.md` | 手順4の Agent #1〜#5 と「Examples of false positives」（英文のまま引用） |
| `.claude/agents/review-scorer.md` | 手順5の採点基準（英文のまま引用） |
| `.claude/skills/review-panel/SKILL.md` | 手順1〜8の流れ |

## 更新の手順

プラグインの固定の更新（[setup.md](../setup.md) の節8、#141）と同じ流れにする。

1. 新しいコミットを選び、写しとの差分（`plugins/code-review/commands/code-review.md` と `plugins/code-review/LICENSE`、NOTICE の有無）を人が読む
2. Issue を立て、PR で写し・LICENSE・この README・root の NOTICE・`docs/review-panel.md` のコミットと、元にしたファイル（上の表）を直す。`harness/test/review-panel-definitions.test.ts` が、採点基準と引用の文が写しと一字一句同じか、コミットがそろうかを確かめる。元にしたファイルはガードレールなので人が Merge する
3. `.claude/settings.json` のマーケットプレイスの固定（今は同じ `fa59bc9`）とそろえるかは、その都度 PR に書く
