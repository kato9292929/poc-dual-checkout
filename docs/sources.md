# データの取り方

日次集計（`scripts/collect-daily.mjs`）が読むものと、その前提。Nevermined の SDK と手順は、実証1の `docs/nevermined.md`（`@nevermined-io/payments` 1.13.0、`@x402/*` 2.28.0）に合わせている。

## 日次の区切り

JST の 00:00〜24:00（`config/period.json` の `utc_offset`）。各トランザクションには `time_utc`（UTC の時刻）と `date_jst`（JST の日付）の両方を記録する。日次データの `window_utc` に、その日の UTC での範囲が入る。

## 計測期間と期間外の日

日次ジョブは開始日（`config/period.json` の `start`）の前から動き、同じ `data/` に日次データを積む。区別は次のとおり。

- 日次データの `period_phase` は `no_period`（開始日未設定）/ `pre_period` / `in_period` / `post_period`。
- 週次レポートは、保存値ではなく **今の `period.json` から日ごとに求め直す**。開始日をあとで入れても、それより前の日は期間前として本表から外れる（`--resummarize` を待たない）。
- 本表（外部・未分類・自社）は期間中の日だけを数える。期間外の日は末尾の「期間外の日」に件数だけ参考として出す。
- 価格の固定値との照合（`price_check` の mismatch）は期間中の日だけに当てる。期間前は価格を変えてよい。
- 欠けた日（日次データが無い日）も、期間中の日だけを数える。

## 一覧

| 項目 | USDC 直接 | カード払い |
|---|---|---|
| 成約件数 | Solana：JIN の payTo の USDC トークン口座への入金 | プラン購入件数：主系は `card.purchase_source`（`stripe`＝Stripe の取引数〔既定〕／`nvm_events`＝Nevermined の `plan.purchased` イベント数）。もう一方は照合用 |
| 利用回数 | 同上（1件＝1回） | 実証1ゲートウェイのログ：`outcome: ok` のコール数と `creditsConsumed` の合計 |
| 購入者数 | 支払い元アドレス（USDC が減った口座の owner） | ゲートウェイのログの `tokenId`（実証1で匿名化済み）の数 |
| 1件あたりの手数料・手数料率 | トランザクション手数料（lamports）× その日の SOL/USD 終値（Binance `SOLUSDC` 日足）。**seller が払った分だけ**。facilitator の分は参考値として別の列 | Stripe：買い手の支払額 − 売り手の受取額（Stripe ＋ Nevermined 2%） |
| 決済1件の所要時間 | 計測用の買い手（`scripts/probe-latency.mjs`） | 同左。加えてゲートウェイのログの `latencyMs` |
| 着金までの日数 | 即時 | Stripe Connect の payout の着金日 − 決済時刻 |
| 照合 | — | Nevermined の Events & Analytics（自社分を含む組織全体の値） |

取れなかったものは 0 で埋めず、null のまま `sources` に理由を残す。

| `sources` のキー | 値 |
|---|---|
| `usdc_chain`, `sol_usd`, `page` | `ok` / `not_configured` / `error: …` |
| `gateway_log` | `ok` / `missing`（口が未接続・トークン未設定。欠損）/ `error: …`。`--resummarize` で埋めた日は `gateway_log_backfilled_at` が付く |
| `stripe` | `ok` / `missing`（`STRIPE_RESTRICTED_KEY` 未設定）/ `error: …` |
| `stripe_csv` | `ok` / `not_found` / `error: …`（購入者を特定できる列がある、など） |
| `nvm_api` | `ok` / `unavailable`（403 などで取れない。理由は `nvm_api_reason`）/ `not_configured` |
| `latency_probe` | `ok` / `not_found` |

## 購入者の分類

| 区分 | 条件 |
|---|---|
| own | `config/own_wallets.json` の Solana アドレス・トークン ID・Stripe 取引に一致。または、実証1ゲートウェイのログの `upstreamTx` と一致する USDC の支払い（カード払いの裏側でゲートウェイが JIN を買ったもの） |
| external | `config/external_buyers.json` に一致（外部と確定したもの） |
| unclassified | どちらにも一致しない。自動で external にはしない |

週次レポートは external を本表、unclassified を別表（支払い元アドレス・トークン ID の一覧付き）、own を参考値の表に出す。分類は明細に対して集計のたびに当て直すので、リストを直したら `--resummarize` で過去の日も数え直せる。

`own_wallets.json` には公開アドレスだけを書く。秘密鍵・環境変数・`.env` は読まない。

| 自社の支払い元 | アドレス | 出所 |
|---|---|---|
| AA | `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY`（2026-10-15 確定） | 下の「AA のアドレスの確認」 |
| Seller Probe | 未取得 | 設定ファイルにも、コミット済みのログにも公開アドレスが無い（秘密鍵から実行時に導出）。有料の測定もまだ一度も動いていない（下の「チェーン読み取りの確認」） |
| 実証1のゲートウェイ | 未作成 | 作成時に追加する。それまでもゲートウェイログの `upstreamTx` と一致する支払いは own |

`candidates` は own の候補の注記で、照合には使わない（unclassified のまま、注記だけ付く）。確定したら `solana` に移し、`resolved` に記録する。

### AA のアドレスの確認（2026-10-15）

- `https://aa.x402jp.com/api/runs`（公開）の各 run の結果に、支払いの tx 署名（`txHash`）が出ている。JIN（`/api/jin/movers`）への支払いは 2026-09-26〜10-14 の20件で、毎日 21:00 UTC（06:00 JST）の run と、10/14 10:22 UTC の run。
- 20件の tx をすべてチェーンから読み（`getTransaction`）、支払い元（USDC が減った口座の owner）を取った。20件とも `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY` だった。
- 実証2の集計期間にかかるのは、`irt5N3uK91…`（10/12 JST）、`6154hajSEe…`（10/13）、`4Dj6mCQEV6…`（10/14）、`5xCZSNuRsM…`（10/14）。tx 署名の全文は `own_wallets.json` の `evidence`。
- `/.well-known/agent-card.json`（EIP-8004 の登録情報。Base の agentId 55560）と `/dashboard` には、Solana のアドレスも tx 署名も出ていない。
- 10/14 10:23:08〜10:23:13 UTC の $0.01 × 5件は、JIN の series ではなく **OSD の購入**だった。AA の `/api/runs` の 10:23:07 UTC の run に OSD の5つのエンドポイントとして載っていて、tx 署名も一致する（`tnFjvvpYWe…` ほか）。2026-10-15 の報告では JIN のエンドポイントだけで突き合わせたため「載っていない」と書いたが、誤りだった。
- **AA の公開ログに載っていない支払い（10/15 の $0.001 × 196件）**：チェーン上の事実は次のとおり。AA の `/api/runs`（直近60回分、9/27〜10/15）に該当する run は無い。何の実行だったかは AA の運用者の確認待ち。AA のログを一次資料にするときは、チェーンの記録と一致するとは限らない前提で扱う。own の判定はアドレスで行うので影響しない。

  | 項目 | 値 |
  |---|---|
  | 件数・合計 | 196件、各 1000（$0.001）、合計 0.196 USDC |
  | 時刻 | 2026-10-15 00:00:20〜00:16:49 UTC（09:00:20〜09:16:49 JST）。間隔の中央値 2秒（最短 1秒、最長 22秒） |
  | 支払い元 | `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY`（AA）だけ |
  | 送金先 | JIN・OSD 共有の payTo `4s8X…3VPf`（USDC 口座 `DRg7rZXr…jjjy`） |
  | 商品 | 金額 $0.001 は OSD の `/api/catalyst/:ticker` か `/api/edinet/:code`（JIN に $0.001 のエンドポイントは無い） |
  | チェーン手数料 | すべて PayAI（`CjNF…eKww`）が fee payer |
  | 最初と最後の tx | `2eb7AcXKSh8j8V4a9im7UeYLhcfy5H4HFcwS7skmGP5EJp2FFkqd6ogfW9jhVx8cjjsk1G272K16PtcmS22hEpaB` / `PS1w4Q8wKLZqbeqNH6an55cKuqL5dF3CEFvjttXwKBJCs2ezRctLwp8BT9oqZMEfudA6cAXRRUYSW4k7t9GWvwV` |

## USDC 直接

- `getTokenAccountsByOwner` で payTo の USDC トークン口座を見つけ、`getSignaturesForAddress` で JST の1日分の署名を集め、`getTransaction`（jsonParsed）で payTo の残高が増えたものだけを数える。金額で series（10000）と movers（20000）に分ける。
- tx ごとに、チェーン手数料を誰が払ったか（`fee_payer_role`）を記録する。

  | `fee_payer_role` | 条件 |
  |---|---|
  | `facilitator` | fee payer が `config/site.json` の `usdc.facilitator_fee_payers`（JIN の 402 の `extra.feePayer`、`CjNF…eKww`） |
  | `seller` | fee payer が payTo か `usdc.seller_fee_payers` |
  | `buyer` | fee payer が支払い元（payer） |
  | `other` | どれでもない |

- 売る側の手数料（`seller_fee_usd`・`seller_fee_rate`）には `seller` の分だけを入れる。`facilitator` の分は `facilitator_fee_usd`・`facilitator_fee_rate` として参考値の列に出す。`buyer` の分も参考に出す。

### チェーン読み取りの確認（2026-10-15）

**seller-probe の 10/12 の支払い**：10/12（月曜）は seller-probe の有料測定（`paid-weekly.yml`、月曜 04:41 UTC）の曜日だが、その日に JIN への $0.01 の支払いは無かった。確認した場所は次のとおり（いずれも読み取りのみ）。

- GitHub Actions の実行履歴（`kato9292929/seller-probe` の全 workflow run）：2026-10-15 時点で2回だけ。どちらも `free-probe (daily)`（10/14 08:42 UTC と 10/15 08:16 UTC、いずれも failure）。`paid-probe (weekly)` と `self-check (weekly)` は一度も動いていない。
- コミット済みのログ：`main`・`claude/friendly-volta-rsj0kc` とも `log/`・`self-check/`・`data/` は `.gitkeep` だけ。
- JIN の payTo の入金履歴：JST 10/12〜10/14 の入金は9件で、支払い元はすべて AA（`7PVT…`）。$0.01 の入金は 10/14 の AA の5件だけ。

**取りこぼしの確認**：JST 10/12〜10/14 について、現行の方法（payTo の USDC トークン口座 `DRg7rZXr…jjjy` の署名一覧）と別経路（payTo 本体の署名一覧、トークン口座の失敗 tx を含む全署名）を突き合わせた。

- 入金の tx 9件は、すべて現行の方法で拾えていた。取りこぼしは無い。
- 現行の方法に無かったのは `tscBHt2Ff5…`（10/14 08:10 UTC）の1件だけで、これは payTo **から** `Fs2zgBUo…` への 1 USDC の出金（fee payer はファシリテーター）。入金ではないので、集計に入らないのが正しい。
- payTo の USDC トークン口座は1つだけ（`getTokenAccountsByOwner`）。

### 受取アドレスを OSD と共有している（2026-10-16 確認）

**JIN の payTo（`4s8X…3VPf`）は、OSD（`osd.x402jp.com`）の Solana の payTo と同じ。** OSD の discovery（`https://osd.x402jp.com/.well-known/x402.json`）と 402 の `PAYMENT-REQUIRED` の両方で確認した。そのため、payTo への入金には OSD の売上も入る。

| 金額（atomic） | JIN | OSD | 判定 |
|---|---|---|---|
| 20000（$0.02） | movers | — | JIN だけ |
| 10000（$0.01） | series | alpha の7つのエンドポイント（`/api/alpha/...`） | **区別できない** |
| 1000（$0.001） | — | `/api/catalyst/:ticker`、`/api/edinet/:code` | OSD だけ |

- tx の memo は支払いごとのランダムな値（16 バイトの16進）で、どのエンドポイントの支払いかは分からない。チェーンの情報だけでは、JIN の series と OSD の $0.01 を区別できない。
- いまの集計（`by_item`）は 10000 を `series`、1000 を `other` としている。10000 には OSD が混ざりうる。実例として、10/14・10/15 の AA の $0.01 × 5件はすべて OSD だった。
- **扱い（2026-10-17〜）**：各支払いに `product`（`jin_movers` / `jin_series` / `osd` / `unresolved` / `other`）と `product_source` を付ける。金額で決まるのは $0.02 → `jin_movers`、$0.001 → `osd` で、$0.01 は `unresolved`。売り手ログ（`docs/seller-log.md`）か AA の公開 run ログで tx が一致したものだけ確定する。JIN の成約数は、確定したものだけの下限〜`unresolved` を含めた上限の幅で出す（日次データの `schema_version` 2）。チェーン手数料・着金・所要時間は受取口座の性質なので、商品に関係なく入金すべてで数える。

### 外部の公開情報で振り分けられるか（2026-10-17 確認）

| 調べたもの | 結果 |
|---|---|
| ファシリテーター `CjNF…eKww` | **PayAI**（payai.network）の Solana の署名者。`https://facilitator.payai.network/supported` の `signers` に載っている。x402scan のファシリテーター一覧（`https://www.x402scan.com/facilitators`）でも PayAI の項目にある |
| PayAI の決済履歴 | 公開の API は `/supported`・`/verify`・`/settle`・`/discovery/resources` だけ。`/settlements`・`/transactions`・`/history` は 404。`/discovery/resources` は商品の一覧（Bazaar）で tx は含まない。決済履歴は公開されていない |
| x402scan | 受取先・サーバーのページはクライアント側で描画していて、HTML に tx もエンドポイントも無い。公開ソース（`Merit-Systems/x402scan`）では、決済の記録（`TransferEvent`）は送り手・受取先・tx・ファシリテーターだけで、エンドポイントを持たない。チェーンの転送から作っているので、同じ受取口座の2商品は区別できない |
| AA の公開 run ログ（`https://aa.x402jp.com/api/runs`） | AA 自身の購入について「エンドポイント ↔ tx 署名」がある。**売り手ログと同じ形で取り込んでいる**（`lib/aa-runs.js`）。直近の run しか公開されていないので、日次集計のたびに取り込んで明細に残す。対象は AA の購入だけ |

結果：外部の購入者の $0.01 を振り分けられる公開情報は無い。売り手ログ（`docs/seller-log.md`）が要る。AA の購入は AA の公開 run ログで確定でき、10/12〜10/16 の AA の $0.01 はすべて OSD だった。

### seller-probe の公開アドレス（2026-10-17 時点で未特定）

- 設定ファイル・コミット済みのログ（`main`・`claude/friendly-volta-rsj0kc`）・Actions の実行ログ（無料の測定2回）のどれにも、ウォレットの公開アドレスは出ていない。無料の測定はウォレットを使わないので、実行ログにも出ない。
- **代わりの特定方法**：有料の測定（`paid-probe (weekly)`、月曜 04:41 UTC＝13:41 JST）が初めて動いた週に、その月曜の日次データを見る。04:41 UTC の直後に、AA 以外の支払い元から JIN の series（$0.01）か OSD の $0.01 の入金があれば、それが seller-probe のウォレット。seller-probe は1コール $0.01 が上限なので movers（$0.02）は買わない。seller-probe のコミット済みのログ（`log/YYYY-MM-DD.jsonl` の `paid` レコードの `tx`）が出ていれば、その tx をチェーンで読んで支払い元を取るほうが確実。確定したら `own_wallets.json` に出所（URL と tx 署名）を添えて書き、`--resummarize` で数え直す。

### 読み取りの網羅性の2度目の確認（予定）

seller-probe はまだ一度も有料の測定を動かしていない（Actions の実行は無料の測定が2回だけで、どちらも失敗。失敗の原因は測定ではなく、結果をコミットするときの `git pull --rebase` で README が競合したこと。seller-probe の側の問題）。上の「取りこぼし無し」は、AA の支払いと別経路の署名一覧との突き合わせで確かめたもので、seller-probe の支払いでは確かめていない。seller-probe の `paid-probe (weekly)`（月曜 04:41 UTC）が動き始めたら、その日の payTo への $0.01 の入金が日次データに現れるかを確かめる。seller-probe の公開アドレスが分かれば、own として現れるはず。

## カード払い

### 実証1ゲートウェイのログ

- 実証1の `src/log.ts` の `RequestLogEntry`（1リクエスト1行）を、実証1ゲートウェイの口 `GET /logs/:date` から読む。URL は `config/site.json` の `card.gateway_base_url` ＋ `card.gateway_log_path`（`/logs/{day}`）。**`:date` は JST の日付**（実証1の B1 と揃えた。2026-10-17）。受け取った行は、念のため JST のその日の範囲でも絞る。Bearer は実証1の `LOG_READ_TOKEN`（読み取り専用）。`GATEWAY_LOG_URL` を設定すればそちらを優先する。
- 残すのは `time_utc`（旧形式の `ts` も読む）・`tokenId`・`payerId`・`routeId`・`outcome`・`verify`・`settle`・`creditsConsumed`・`latencyMs`・`upstreamLatencyMs`・`upstreamTx`・`upstreamNetwork` だけ。パスやエラー本文は残さない。`upstreamTx` の `'none'` は null にする。
- **買い手は `payerId`（Nevermined の購入者を実証1で匿名化した値）で数える。** `tokenId` は x402 の支払いトークンで購入ごとに変わるため、買い手の数には使えない。自社の買い手（実証1の買い手エージェント、実証2の計測用）は `own_wallets.json` の `card_payer_ids` に入れる。`payerId` は実証1の `LOG_SALT` で匿名化した値なので、**期間中は実証1の Vercel の `LOG_SALT` を変えない**（変えると同じ買い手が別の ID になり、自社の買い手が外部として数えられる）。`payerId` を残す前に取った日は、`--resummarize` でログを取り直す。
- **口は 2026-10-22 から開いている**（`https://poc-card-credits.vercel.app`、`card.gateway_base_url`）。読むには GitHub Secrets の `LOG_READ_TOKEN` が要る。それまでの日は `gateway_log: "missing"`（欠損）として記録してある。トークンを入れたら、daily の Action を `resummarize` に範囲（例 `2026-10-19..2026-10-21`）を入れて手動で実行するか、`node scripts/collect-daily.mjs --resummarize <開始日>..<終了日>` を実行すると、欠損の日だけログを取りに行って埋め、数え直す。
- **カード入口の成約**＝ログの `outcome: "ok"`（settle 成功・クレジット消費）。`settle_failed`（上流の JIN には払ったがクレジット未消費）は成約に入れず、`card.settle_failed` として別に数える。JIN の売り手ログには売上として出るので、JIN 側の件数とはその分ずれる（`card.contract_definition`）。
- **カード入口は JIN series と OSD JP catalysts（どちらも $0.01）を交互に買う**（プランが 1 リクエスト 1 クレジット固定なので movers は無い）。入口の比較は JIN series でそろえ、OSD の行（`routeId: osd.jp.catalysts`）は外す。`card.calls` などは `card.products` の商品だけで数え、全商品の成約は `calls_by_product` に出す（`card.route_products` で routeId を商品に対応づける）。
- **ゲートウェイのウォレット** `3HG2…rcgV`（実証1 の `docs/wallet.md`）は `own_wallets.json` に `role: "card_gateway"` で入れてある。ここから JIN / OSD への支払いは USDC 入口の外部の買い手から外れる（own）。日次の `gateway_upstream` に、チェーン側の件数（商品別）とログの ok / settle_failed の件数、ログに無いチェーン側の支払いの件数を並べて照合する。
- **ログの欠け**は `card.known_gaps` に書く。2026-10-21 はゲートウェイのログが 3 回分欠けている（JIN series 2・OSD 1。Blob の不具合、実証1の `d6f036e` で修正済み）。欠けた 3 回はどれも成約（支払い・クレジット消費とも正常）で、10/21 の JIN series の成約は実際には 5 件（ログ 3＋欠け 2、`known_gaps.contracts_incl_missing`）。JIN の売り手ログとの差は、欠け 2 と settle 失敗 1 の計 3 件。10/21 は実証1の手動確認の呼び出しも含み、定期実行は 10/22 から。
- settle 失敗は 10/23 時点で 2 回（JIN series 1＝2026-10-21T10:43:55Z、OSD 1）。`gateway_upstream.log_settle_failed_by_product` で商品別に出る。
- `upstreamNetwork` は上流に支払った行だけに入る。全行に入るのは `upstreamNetworkMode`。
- 入金までの日数（カード側）：実証1の Stripe Connect は Sandbox で接続済みだが、テスト決済で実際の入金が起きないため、本番（Live）に移るまで出ない。
- 買い手エージェントのログ `GET /logs/buyer/:date`（同じトークン、`card.buyer_log_path`）は週次レポート用。まだ読んでいない。

### Stripe

- 制限付きの読み取り専用キーを `STRIPE_RESTRICTED_KEY` から読む（権限は Balance transactions・Payouts の Read）。
- 直接課金は `type=charge`、destination charge は接続アカウント側で `type=payment` になる。どちらも数える。
- 着金日は `GET /payouts?status=paid` と `GET /balance_transactions?payout=po_…` で取引ごとに引き、毎日、直近45日分を書き足す。
- 取引 ID は `ANON_SALT` で匿名化して保存する。
- キーが未設定の日は、手数料と着金日を null にして `stripe: "missing"` と記録する。
- `data/stripe/YYYY-MM.csv`（手で書き出した CSV）があれば、それも読む。API で取れた取引が優先で、CSV にしか無い取引を足す。CSV に置いてよい列は `data/stripe/README.md` のとおり。購入者を特定できる列があれば読まずにエラーにし、テスト（`test/data.test.js`）も落ちる。

### Nevermined（照合用）

- `GET /organizations/{orgId}/analytics/revenue`・`/usage`、`/activity?eventType=plan.purchased`。集計値は自社分を含む組織全体の値で、日次データの `nvm_reconcile_incl_own` に入る。`plan.purchased` は1件ずつ（userId を匿名化）`detail.card.nvm_purchases` に残し、`card.purchase_source` が `nvm_events` のときはこれがプラン購入件数の主系になる（購入者は `own_wallets.json` / `external_buyers.json` の `nvm_user_hashes` で分類）。
- 組織が Premium 以上でないと 403。そのときも処理は止めず、その日は `nvm_api: "unavailable"` と記録する。
- 形の崩れた `orgId` だと 200 で全ゼロが返るので、`org-` で始まる形でなければ呼ばない。
- 参考: <https://nevermined.ai/docs/agents-guide/check-revenue.md>

## 決済1件の所要時間

`scripts/probe-latency.mjs` が、毎日1回、両方の入口を同じ手順で測る。

1. 支払い情報なしで GET → 402（`first_ms`）
2. USDC 直接：402 の提示を検査し（金額・payTo・資産が設定と完全一致のときだけ）、`@x402/svm` で署名する（`sign_ms`）。カード払い：事前に発行したアクセストークンを使う（0）
3. 支払い情報（`PAYMENT-SIGNATURE` / `payment-signature`）を付けて GET → 200（`paid_ms`）

`total_ms` が「リクエストから 200 まで」。

- 計測用の買い手は自社。新しく作った Solana ウォレットの公開アドレスと、カード側のトークン ID を `own_wallets.json` に書く。
- カード払いのトークン発行（`getX402AccessToken`）は事前に1回やるので、時間に含めない。
