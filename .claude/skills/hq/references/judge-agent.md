# hq の参照用のファイル：判断の担当（hq-judge）

hq の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## 判断の担当（hq-judge）

hq は決まった手順（見張り・`hq-decide.ts` の結果に従う処理・Orca の操作・AskUserQuestion）だけを回し、判断の要る3つの場面だけをサブエージェント `hq-judge`（[.claude/agents/hq-judge.md](../../../agents/hq-judge.md)。モデルは `opus`）に決めさせる（#781）。判断が要るかは `hq-decide.ts` の出力の `judge` が返し、`judge` が null でなければ必ず担当を呼ぶ（呼ぶかを hq のモデルに選ばせない）。

| 場面 | 印 | 呼ぶとき | 担当が返すもの |
| --- | --- | --- | --- |
| `theme`（手順3・手順8の空きの補充） | `themes` の `judge: theme` | 起こせる候補の Epic が2つ以上で、空き（`slots`）が1以上 | 起こす Epic の並び（空きの数まで）と Epic ごとの理由の一言。`files` が重なる組は同時に入れない |
| `split`（手順7・節「相談・アイデアを intel に回す」） | `route` の item の `judge: split` | 件名 `notice` で印の無いもの（`notice-unmarked`）と、人が hq のタブに直接言った相談・アイデア | 人に上げる部分・intel に回す部分・一覧にためるだけの部分（無ければ null）。迷ったら人に上げる側 |
| `summary`（手順9・手順12） | `route` の item の `judge: summary` | `worker_done`（`--report-path` のレポート） | 人に出す要点（5件まで）と、人がすることの項目 |

- **渡すもの**：材料はすべて scratchpad のファイルで渡す（`theme` は `themes` の出力、`split` は便りの本文、`summary` はレポート）。出力のパスは scratchpad の `hq-judge-<場面>-<回数>.json`。担当は GitHub・Orca・git を読まず、人に聞かない。
- **呼び方**：`run_in_background` にせず前で呼んで待つ。
- **返りの使い方**：出力のパスの JSON（`scene` が場面と同じ）に従う。`theme` は `start` の順に起こし、理由を手順12の一覧に載せる。`split` は `human` を hq が人に伝え（AskUserQuestion は hq が行う）、`intel` を intel に回し、`list` を手順12の一覧にためる。`summary` は要点と項目を手順12の一覧に載せる。
- **書かなかったとき**：担当がファイルを書かなかった・JSON として読めないときは、担当を1回だけ呼び直す。それでも無ければ、`theme` は手順12の一覧に「テーマを決められなかった」と出し、`split` は人に上げる側にし、`summary` はレポートをそのまま一覧に出す。
