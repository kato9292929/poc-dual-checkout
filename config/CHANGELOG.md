# 除外リスト（config/exclusions.json）の変更履歴

除外リストを変えるときは、次の3つを同じコミットで行う。

1. `config/exclusions.json` の `version` を1つ上げ、`updated` を更新する
2. `history` に1行足す
3. 下の表にも1行足す

日次データ（`data/YYYY-MM-DD.json`）には、集計に使った `exclusions_version` が残る。除外は日次データの明細（`detail`）に対して集計のたびに当て直すので、過去の日を新しいリストで数え直すときは次を実行する。

```sh
node scripts/collect-daily.mjs --resummarize 2026-11-01..2026-11-28
```

数え直したことは週次レポートに書く。

| version | 日付 | 変更 | 理由 |
|---|---|---|---|
| 1 | 2026-10-13 | 初版 | — |
