# 購入者の分類リストの変更履歴

購入者は3つに分ける。

| 区分 | 条件 | リスト |
|---|---|---|
| own | 自社の支払い元に一致 | `config/own_wallets.json`（`candidates` は候補の注記だけで、照合には使わない） |
| external | 外部の購入者と確定 | `config/external_buyers.json` |
| unclassified | どちらにも一致しない | — |

一致しないものはまず unclassified に入れる。自動で external にはしない。

リストを変えるときは、次の3つを同じコミットで行う。

1. そのファイルの `version` を1つ上げ、`updated` を更新する
2. `history` に1行足す
3. 下の表にも1行足す

日次データには、集計に使った版（`classification.own_wallets_version` / `external_buyers_version`）が残る。分類は日次データの明細に対して集計のたびに当て直すので、過去の日を新しいリストで数え直すときは次を実行する。

```sh
node scripts/collect-daily.mjs --resummarize 2026-10-12..2026-11-28
```

数え直したことは週次レポートに書く。

| ファイル | version | 日付 | 変更 | 理由 |
|---|---|---|---|---|
| own_wallets.json | 1 | 2026-10-13 | 初版（AA・Seller Probe は pending） | 公開アドレスが各リポジトリの設定に無い |
| external_buyers.json | 1 | 2026-10-13 | 初版（空） | — |
| own_wallets.json | 2 | 2026-10-14 | candidates・nvm_user_hashes を追加。`7PVT…L6tY` を AA の候補として注記（unclassified のまま） | movers $0.02 は seller-probe の上限 $0.01 を超える。AA のアドレス確定待ち |
| external_buyers.json | 2 | 2026-10-14 | nvm_user_hashes を追加 | プラン購入件数の主系を nvm_events に切り替えられるようにした |
