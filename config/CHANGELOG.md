# 判定ルール（config/classify.json）の変更履歴

判定ルールを変えるときは、次の3つを同じコミットで行う。

1. `config/classify.json` の `version` を1つ上げ、`updated` を更新する
2. `history` に1行足す（何を・なぜ変えたか）
3. 下の表にも1行足す

日次データ（`data/YYYY-MM-DD.json`）には、その日の集計に使った `classify_version` が記録される。過去の日を新しいルールで数え直すときは `node scripts/collect-daily.mjs --date YYYY-MM-DD` を再実行し、その旨を週次レポートに書く。

| version | 日付 | 変更 | 理由 |
|---|---|---|---|
| 1 | 2026-10-13 | 初版 | — |
