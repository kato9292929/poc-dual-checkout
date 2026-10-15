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
| own_wallets.json | 3 | 2026-10-14 | `7PVT…L6tY` の候補の根拠を、連日 06:00 JST の支払い（週1回の seller-probe と頻度が合わない）に差し替え。上限 $0.01 は補強 | 10/13 にも同時刻の支払いがあり、消去法が上限額に依存しなくなった |
| own_wallets.json | 4 | 2026-10-14 | 候補の注記を各トランザクション（`own_candidate`）にも付け、文言を「自社 AA の候補、movers $0.02 の毎日購入」に揃えた | 10/12 と 10/13 の各1件に同じ注記を付けるため |
| own_wallets.json | 5 | 2026-10-15 | AA の公開アドレス `7PVT…L6tY` を記入し、候補から外した | aa.x402jp.com/api/runs の tx 署名20件をチェーンで読み、支払い元がすべてこのアドレスだった |
