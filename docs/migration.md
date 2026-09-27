# 個人の public から組織の private への移行

## 先に決めること

| 決めること | 判断者 | 不可のとき |
| --- | --- | --- |
| 社内のコード（diff）を外部 API の Jev に送ってよいか | 情報セキュリティ担当 | `JEV_API_KEY` を置かず `jev.mode` を `off` |
| Routine の毎時実行が Claude の規約上の「通常利用」に収まるか | Claude の契約管理者（不明なら Anthropic） | Routine を使わず人のセッションだけで運用 |
| 社内ルール（社内コードを Claude に扱わせる、社員名義で Agent が書き込む） | 情報システム部門・所属長 | 移行しない |
| 費用（Jev の従量課金、Actions の無料枠超過） | 予算の承認者 | Actions は使用上限を設定 |

## 方式

| 観点 | Transfer（推奨） | 新規作成 |
| --- | --- | --- |
| Issue・PR・App の記録 | 引き継がれる | 引き継げない（Issue は作り直し） |
| `report.ts` の集計 | そのまま続く | 旧リポジトリで集計して保存し、手で合算 |
| 設定 | 引き継がれる想定。移行後に `setup.ts` で掛け直して確認 | すべて設定し直す |
| 戻し方 | 社内コードが入った後は public に戻せない | 旧リポジトリを再開すればよい |

App も組織へ移管すると slug と ID が変わらず、App の記録（計画の写し・受け付け・ダッシュボード）をそのまま信頼できる。新規作成した場合は `appSlug`・`AGENT_APP_SLUG`・Ruleset の `integration_id` を掛け直し、仕掛かりの計画・判定はやり直しになる。

## 移行で変わること

- コメントできるのがリポジトリにアクセスできる人だけになり、外部からの偽の計画・判定コメントの心配がなくなる。
- 組織では `author_association` の MEMBER が組織メンバー全員を指す。組織の Base permissions を No permission にし、リポジトリの権限を絞る。
- private の fork を禁止できる。ただし「ゲートは PR の head を実行しない」前提は変えない。
- Merge queue が使えるようになる。使う場合は、App のチェック（`agent/review`・`merge-route`・`agent/plan-link`・`agent/title`・`agent/tests`）を Merge queue の一時コミット（`merge_group` イベント）にも書くようゲートを直す必要がある。直さずに有効にすると、必須チェックが揃わず Merge されない。
- Actions が課金対象になる。目安は 1 Issue あたり約 11 分と停滞検知の月 240 分（月 100 Issue で約 1,350 分）。

## 手順

1. 開いている Agent PR を片付け、Routine を無効化し、ダッシュボードに停止ラベルを付ける。
2. `report.ts` の集計を保存する。
3. リポジトリ（と App）を組織へ移管し、private にして fork を禁止する。
4. App を組織の対象リポジトリだけにインストールし直す。
5. [setup.md](setup.md) の手順 3〜5 を実行して設定を掛け直し、動作を確かめる。
6. 組織の Claude の管理者設定で Routines と Claude Code on the web を有効にし、Routine を作り直す（[setup.md](setup.md) 手順 6）。
7. 小さな Issue で計画から Ready 化まで通してから、停止ラベルを外す。
