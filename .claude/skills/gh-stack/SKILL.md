---
name: gh-stack
description: 人が付き添うセッションで、Stacked PR（層を重ねた PR）を組む・見る。層ごとに gh pr create --draft で出してから gh stack link で PR 番号だけを組み、gh stack view と移動で確かめる。「スタックを組んで」「Stacked PR にして」と頼まれたとき、implement の「Stacked PR で出すとき」から使う。Routine では使わない。
---

# gh-stack（Stacked PR を組む・見る）

GitHub の Stacked PR（下の層のブランチを base にした PR を重ねたもの）を、このハーネスで許す操作だけで組む手順。使えるのは付き添いのセッションだけ（Routine の環境には gh が無い）。いつ積んでよいか・層の本文・Merge・追従の決まりは [harness/CLAUDE.harness.md](../../../harness/CLAUDE.harness.md) の進め方と [docs/operations.md](../../../docs/operations.md#stacked-pr) にある。

出典：GitHub の [github/gh-stack](https://github.com/github/gh-stack) の `skills/gh-stack/SKILL.md`（タグ v0.1.1、コミット `2bd699a`、MIT License、Copyright GitHub, Inc.）。上流の skill は `submit`・`push`・`sync`・`rebase`・`modify`・`merge` を使う手順なので写さず、このハーネスで許す操作だけの手順として書き直した。gh-stack の版は v0.1.1 にそろえる。

## 入力

- 層ごとの Issue（1層＝1 Issue）。どれも計画ゲートを通った（または人が進めると決めた）計画がある
- 積む理由：上の層が、下の層と同じファイルを触る・下の層が足したものを使う・PR 本文に `Stack: 理由` を書く、のどれか（当たらなければ積まずに別々に `main` 宛てで出す）
- gh-stack（`gh extension install github/gh-stack --pin v0.1.1`。入っていなければ `gh stack` は入れるよう案内して止まる）

## 手順

1. 層ごとに implement の skill の手順で、claim・worktree・ブランチ（`claude/issue-<番号>-<短い名前>`）を用意して実装する。上の層の worktree は、作った直後に `git merge --ff-only origin/<下の層のブランチ>` で下の層に合わせる（implement の「Stacked PR で出すとき」）。
2. 下の層から順に `gh pr create --draft --base <下の層のブランチ（一番下の層は main）>` で Draft PR を出す。本文は PR テンプレートどおりで、下の層は `Refs #<番号>`、一番上の層は `Closes #<番号>`（どちらも1つだけ）。積む理由が本文にしか無いときは `Stack: 理由` の行を書く。
3. 上の層は出した直後、base が既定ブランチでないので App が orphan-base（Draft のまま `agent:blocked`、`kind=orphan-base`）にする。組めば App が戻すので、この間は待つだけでよい。
4. 全部の層を出したら、下から上の順に PR 番号（または PR の URL）だけを渡して組む：`gh stack link <下の PR 番号> <上の PR 番号>`。すでにあるスタックの上に足すときは、1つ目にスタック番号を渡す：`gh stack link <スタック番号> <足す PR 番号>`。数字が PR でもスタックでもないと、gh-stack はそれをブランチ名として読んで push するので、先に `gh pr view <番号>` で PR があることを確かめる。
5. `gh stack view`（`--json`・`--short` も可）で、層の順と base が意図どおりかを確かめる。層の間を行き来するときは `gh stack up`・`gh stack down`・`gh stack top`・`gh stack bottom`・`gh stack switch`・`gh stack trunk` を使ってよい（ローカルのブランチを切り替えるだけ）。
6. 層ごとに judge の skill で判定する（diff はその PR の base からの差分）。追従が要れば sync の skill で `git merge` する（下の層を上の層に、`main` を一番下の層に。下から順に）。

## 使わない操作

見張りの hook（`.claude/hooks/guard.ts`）が止める。止められたら別の方法で試さず、人に返す。

- `gh stack merge`（スタックの Merge。人が GitHub の画面で行う）と、スタックの Merge の API（`…/pulls/<番号>/merge-async`）
- `gh stack push`・`sync`・`rebase`・`submit`・`modify`（force push を含みうる。追従は `git merge`、push は層ごとに `git push origin <層のブランチ>`）
- `gh stack alias`（別名で hook の見張りを避けられる）
- `gh stack unstack`・`checkout`（リモートのスタックを外しうる）・`init`・`add`・`feedback` など、上の一覧に無いサブコマンド
- ブランチ名を渡す `gh stack link`（ブランチを push して PR を作る。PR は手順2で先に出す）、フラグを付けた `gh stack link`（`--open` は Draft の解除、`--base`・`--remote` は送り先を変える）
- `gh extension exec stack …`・`gh-stack …` の直接の実行でも同じ

## 終わりの状態

- 全部の層が Draft PR として出ていて、`gh stack view` でスタックとして組まれている。
- 上の層の orphan-base が App によって戻っている（`kind=base-resolved`）。
- Merge はしていない。スタックは Human Merge で、全部の層が Ready になってから人が GitHub の画面で Merge する。

## 人に返す条件

- gh-stack が入っていない、または版が v0.1.1 でない
- 積む理由（3条件）のどれにも当たらない（積まずに `main` 宛てで出す）
- `gh stack link` の後も数分以上 orphan-base のまま戻らない
- hook が `gh stack` の操作を止めた（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、force push、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped`・`agent:delegate-plan`・`agent:delegate-merge`・`agent:bypass-merge` と `*:exempt` のラベルの付け外し
