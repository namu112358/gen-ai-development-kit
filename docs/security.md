# 安全設計（実装との対応）

Claude はユーザー本人の名義で動くため、GitHub 上の印で「人がやった」とは証明できない。信頼の置き場所は「起動経路」と「専用 App の操作（既定ブランチの YAML からのみ）」の2つ。

| 観点 | 実装 |
| --- | --- |
| 起動 | Claude は人のセッションと定期 Routine だけ。`gate.yml` は Claude を動かさない |
| 信頼の根 | App の名義（`<appSlug>[bot]`）で書かれたラベルイベント・コメント・Check Run だけを信頼する（`harness/lib/state.ts`） |
| ゲートの起動 | `issue_comment` / `issues` / `pull_request_target` / `push: main` / `schedule`。いずれも既定ブランチの YAML が動く |
| PR のコード | ゲートは既定ブランチを checkout し、PR の head は checkout・実行しない。diff は compare API で読むだけ |
| 埋め込み | イベントの中身は `GITHUB_EVENT_PATH` の JSON から読む。`${{ }}` で本文を run に埋め込まない（`if:` の `contains` のみ） |
| コメントの作成者 | ゲートは `author_association` が OWNER / MEMBER / COLLABORATOR のコメントだけ受け付ける（Q60） |
| 秘密 | App の鍵・Jev の鍵は Environment `gate` の Secret。`gate` は main からの実行に限定。ログ・コメント・Check Run は `redact()` で伏せ字 |
| 必須チェック | `agent/review`・`merge-route` は App の `integration_id` に固定。`ci` は GitHub Actions に固定。bypass なし |
| 段階ゲート | `agent:plan-ok` は App だけ。App 以外が付けたら App が外す。Routine は Timeline で「App が付けた」ことを確認してから実装する |
| 計画の写し | ゲート通過時の計画を App の記録に写す。後で計画コメントが編集されても、実装と範囲照合は写しを使う |
| 範囲照合 | 計画の `files` と PR の変更ファイル（リネームは旧パスも）を App が照合する |
| 判定の鮮度 | 判定時の head と現在の head で PR 自身の差分の `git patch-id` が同じときだけ受け付ける |
| 順序 | push を検知したら最初に auto-merge を解除。受け付け時は auto-merge → merge-route → agent/risk → agent/review の順（`agent/review` が最後） |
| 直接マージ | `.claude/settings.json` の deny（`gh pr merge`、merge API、auto-merge、`gh pr ready`、変数・Secret・Ruleset 変更、main への push）。コマンドパターンのため完全ではない |
| Agent PR | 同じリポジトリの `claude/` ブランチからの PR。fork は含めない。それ以外の PR は `agent/review` を「判定対象外」で通し、自動経路には乗らない（merge-route） |
| 停止スイッチ | ダッシュボード Issue の `agent:auto-merge-stopped`。ダッシュボードが無い・読めない場合は停止扱い（安全側） |

## 受け入れているリスク

計画の「受け入れるリスク」（Q44・Q47・Q50・Q51・Q57・Q59）はそのまま。Q58（パブリック期間のコメント）は作成者チェックを入れたため、残るのは次のとおり：

| リスク | 内容 |
| --- | --- |
| コメントの編集 | ゲートは `created` だけを見る。受け付け後にコメントを編集しても再評価されない（計画は写しを使うので影響は表示のみ） |
| コラボレーター本人 | コラボレーター（＝本人・Routine）が偽の判定を書くことは防げない（Q44：段階分割と将来の Jev で対処） |
| auto-merge 付与と CI 完了の競合 | Routine（本人名義）が medium の PR に auto-merge を付け、`auto_merge_enabled` のゲートが merge-route を failure に書き換える前に CI が完了すると、Merge され得る（数秒の窓）。`.claude/settings.json` で auto-merge の設定を deny している |
| App に workflows 権限がない副作用 | `.github/workflows/**` を変える PR は App の auto-merge で Merge できない。意図した下限ではないが、質問8で critical になるため実害はない |
| Routine の push 先 | Routine は `claude/` 以外のブランチにも push できる可能性がある（Phase 0 で確認）。その PR は Agent PR とみなされず自動経路に乗らないため、Merge には人が必要 |
