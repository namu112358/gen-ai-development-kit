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

## stablyai/orca

| 項目 | 内容 |
| --- | --- |
| リポジトリ | [stablyai/orca](https://github.com/stablyai/orca) |
| コミット | `083f583a53e4c74a65acf420eee4ca2e0efa9df1`（タグ `v1.4.215`、Orca 1.4.215） |
| パス | `skills/orca-cli/SKILL.md` → `.claude/skills/orca-cli/SKILL.md`、`skills/orchestration/SKILL.md` → `.claude/skills/orchestration/SKILL.md`、`LICENSE` → `orca/LICENSE` |
| ライセンス | MIT License（`Copyright (c) 2026 Lovecast Inc.`）。`orca/LICENSE` は同じコミットの root の `LICENSE` |
| NOTICE | 同じコミットの root に NOTICE は無い。このリポジトリの root の [NOTICE](../../NOTICE) に出どころを書いた |

**例外（置き場所）**：この2つの入口は skill として読み込ませるため、`docs/upstream/` ではなく `.claude/skills/` に写しを置く（冒頭の「skill としては読み込まれない場所に置く」の例外）。写しは書き換えない（`harness/test/orca-skills.test.ts` が、改行を LF にそろえた sha256 とコミットを確かめる）。`harness/managed.json` の `.claude/skills/**` で導入先にも配られる。

**写す元**：同じコミットの `skill-stubs/` は差し込み前の元（`orca-cli.md`・`orchestration.md`。frontmatter が無く、`<!-- shared: resolver -->` などの差し込みの目印が残る）なので、差し込み済みで frontmatter の付いた `skills/<名前>/SKILL.md` を写した（Orca が `~/.agents/skills` に入れる入口と同じ中身。#195 の人の決定）。`computer-use` などほかの入口は入れない。

**更新の手順**（[setup.md](../setup.md) の節8と同じ流れ）：

1. 手元の Orca の版に合うタグのコミットを選び、写しとの差分（`skills/orca-cli/SKILL.md`・`skills/orchestration/SKILL.md`・`LICENSE`、NOTICE の有無）を人が読む。入口に素の `orca` で始まるコマンドや、コードを動かす部品（スクリプト・hook）が増えていないかも見る
2. Issue を立て、PR で2つの写し・`orca/LICENSE`・この README・root の NOTICE・[setup.md](../setup.md#11-orca標準の実行環境) の取り込んだ版と、`harness/test/orca-skills.test.ts` のコミットと sha256 の期待値を上げる
3. Merge 後、新しいセッションで `orca-cli`・`orchestration` の skill が一覧に出て読めることを確かめる

## 更新の手順

プラグインの固定の更新（[setup.md](../setup.md) の節8、#141）と同じ流れにする。

1. 新しいコミットを選び、写しとの差分（`plugins/code-review/commands/code-review.md` と `plugins/code-review/LICENSE`、NOTICE の有無）を人が読む
2. Issue を立て、PR で写し・LICENSE・この README・root の NOTICE・`docs/review-panel.md` のコミットと、元にしたファイル（上の表）を直す。`harness/test/review-panel-definitions.test.ts` が、採点基準と引用の文が写しと一字一句同じか、コミットがそろうかを確かめる。元にしたファイルはガードレールなので人が Merge する
3. `.claude/settings.json` のマーケットプレイスの固定（今は同じ `fa59bc9`）とそろえるかは、その都度 PR に書く
