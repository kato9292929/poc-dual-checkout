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
| own_wallets.json | 6 | 2026-10-22 | 実証1のゲートウェイの公開アドレス `3HG2…rcgV` を記入（`role: card_gateway`） | 実証1 の docs/wallet.md。カード払いの裏側の JIN 購入で、USDC 入口の外部の買い手ではない。10/12〜10/21 を `--upgrade` で数え直した（10/21 の 10 件が own に移った） |
| own_wallets.json | 7 | 2026-10-23 | `card_payer_ids` を追加（カードの自社の買い手を payerId で見分ける） | 実証1ゲートウェイのログの tokenId は購入ごとに変わり（10/22 は成約18回で18種類）、買い手数が成約数と同じになっていた |
| own_wallets.json | 8 | 2026-10-23 | `card_payer_ids` に `d0c6c75243d07e82`（実証1の買い手エージェント）を追加 | 10/21〜10/22 のゲートウェイのログの成約・settle 失敗 26 行がすべてこの payerId。カードのプランはまだ一般に売っていない |
| own_wallets.json | 9 | 2026-10-25 | Seller Probe の公開アドレス `xgtJ5…FZW5` を記入。`6JKV…vEzA` を own 候補に追加 | seller-probe の docs/wallet.md と 10/19 の self-check の時刻・tx 署名が一致。6JKV は 8 月に AA と同じ時刻で買っていたウォレットで、10/22 に残高を受取口座へ送金（購入ではない） |
