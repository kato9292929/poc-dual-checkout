# 売り手ログ（エンドポイント ↔ tx 署名）の形式

JIN と OSD は Solana の受取口座（payTo `4s8X…3VPf`）を共有している。金額 $0.01 は JIN の series と OSD の7つのエンドポイントで同じで、tx の memo もランダムな値なので、チェーンの情報だけではどちらの商品か分からない（`docs/sources.md`「受取アドレスを OSD と共有している」）。

区別に使える情報は、売り手のサーバーにしか無い。売り手は、支払い付きのリクエストを受けた時点でどのエンドポイントへの支払いかを知っていて、ファシリテーターの settle 応答で tx 署名も受け取る。この対応を売り手が出し、実証2が日次で読む。

## 読み方（実証2の側。実装済み）

- `GET {SELLER_LOG_URL}/sales/:date`。`:date` は JST の日付（`YYYY-MM-DD`）で、その日（JST 00:00〜24:00）に settle した支払いを返す
- 認証は `Authorization: Bearer {SELLER_LOG_TOKEN}`（読み取り専用のトークン）
- `SELLER_LOG_URL` に `{date}` を含めた場合は、`/sales/:date` を付けずにそこを置き換える
- 404 は「その日のログが無い」。その日の $0.01 は unresolved のまま残る（`sources.seller_log: "missing"`）
- 200 の `[]` は「その日の記録が0件」。JIN の口は記録が無い日に `[]` を返すので、記録を始める前の日とは区別できない。そのため **`config/site.json` の `usdc.seller_log_since`（JIN が記録を始めた日、JST）より前の日、または未設定の間は、消去法を使わない**（ログで一致した tx だけ確定し、残りの $0.01 は unresolved）
- 401 などのエラーは `sources.seller_log: "error: …"` として残し、集計は止めない
- ログがつながったら `node scripts/collect-daily.mjs --resummarize <開始日>..<終了日>` を実行すると、ログが無かった日だけ取りに行って埋め、数え直す

## 形式

JSON の配列（JSON Lines でもよい）。1行が settle した支払い1件。

```json
[
  {
    "tx_signature": "5xCZSNuRsMwDYv2zDMJtS11cWYdwS9ajRbbjPDhH26AeviqbWMhBk1yufgBu5kmWTHgBKzw5nzv7Lv8G79wNMsSX",
    "endpoint": "https://jin.x402jp.com/api/jin/movers",
    "amount": "20000",
    "time_utc": "2026-10-14T10:23:05Z"
  }
]
```

| フィールド | 必須 | 内容 |
|---|---|---|
| `tx_signature` | ○ | settle 応答（`PAYMENT-RESPONSE` の `transaction`）の tx 署名 |
| `endpoint` | ○ | 支払われたリソースの URL（402 の `resource.url`）。パスパラメータは入っていてよい |
| `amount` | ○ | 支払額（USDC の最小単位の文字列。$0.01 = `"10000"`） |
| `time_utc` | ○ | settle した時刻（ISO 8601、UTC） |

購入者を特定できる情報（IP アドレス、User-Agent、支払い元アドレス以外の識別子）は入れない。支払い元アドレスはチェーンから分かるので、このログには要らない。

## 実証2での使い方

- `tx_signature` が一致した支払いは、`endpoint` で商品を確定する（`config/site.json` の `usdc.endpoint_products`）。`product_source` は `seller_log:seller`
- 売り手ログを出すのがどちらかを `config/site.json` の `usdc.seller_log_covers` に書く（`"jin"` / `"osd"`）。その日のログが取れていて、かつ `usdc.seller_log_since` 以降の日なら、ログに無い $0.01 は消去法でもう一方の商品とする（`product_source` は `seller_log_exclusion:…`）。売り手がログを書き損ねるとその支払いを取り違えるので、ログの書き込みは settle と同じ処理の中で行い、失敗したら売り手側で分かるようにする
- AA の公開 run ログ（`https://aa.x402jp.com/api/runs`）にも AA 自身の購入の「エンドポイント ↔ tx 署名」があるので、同じ形に揃えて足している（`product_source` は `seller_log:aa_runs`）。対象は AA の購入だけで、外部の買い手の $0.01 は確定できない。売り手ログと同じ tx があれば、売り手ログを優先する

## JIN と OSD のどちらが出すか（判断材料、2026-10-17 に読み取りのみで見積もり）

| | JIN（`kato9292929/Japan-Inflation-Nowcast`） | OSD（`kato9292929/onchain-stock-data`） |
|---|---|---|
| x402 の処理を通る場所 | `src/lib/x402-route.ts` の `withSolanaOnlyPaywall`（69行のファイル）。series・movers・inflation のルートが全部これを通る | `lib/x402-route.ts` の `withX402AndInternal`（367行のファイル）。`withSolanaOnlyPaywall`（14ルート）・`withSolanaUsdcMicroPaywall`（4ルート）・`withPaywall`・`withTestnetPaywall` が全部これを通る |
| 足すもの | ① `withX402` の応答に `PAYMENT-RESPONSE` があれば、tx 署名・resource・金額・時刻を保存する（約20行）② 保存先（Vercel KV / Upstash の REST を fetch で呼ぶ。約40行）③ `GET /sales/[date]`（Bearer 検証。約30行）④ テスト | 同じ①〜④。①を `withX402AndInternal` の1か所に入れる |
| 変更量の目安 | 3ファイル・約100〜150行。環境変数3つ（KV の URL・トークン、`SELLER_LOG_TOKEN`）。いまは KV の依存が無い | 同程度（1か所に入れるので行数はほぼ同じ）。testnet のルートは除外が要る |
| 判定の仕方 | JIN の支払いを直接確定（ログにあれば JIN）。ログに無い $0.01 は OSD | OSD の支払いを確定し、ログに無い $0.01 は消去法で JIN |
| 実証2にとって | 測りたい商品（JIN）を直接確定できる。対象のルートが少ない（JIN の有料ルートだけ）ので、ログの書き損ねで取り違える範囲が狭い | 対象のルートが多く（約18）、どれかでログを書き損ねると、その OSD の支払いを JIN と取り違える |
| 指示書との関係 | 「jin.x402jp.com の x402 実装を変えない」に触れる（支払いの処理は変えず、settle 後に記録を足すだけ） | JIN には触れない |

**決定（2026-10-18）：JIN が出す。** `config/site.json` の `usdc.seller_log_covers` は `"jin"`。

## JIN 側の変更（docs/patches/jin-seller-log.patch）

実証2からは JIN のリポジトリに書き込まないので、変更はパッチとして置いてある。JIN の `main`（`e133889`）にそのまま当たり、当てた状態で JIN のテスト（vitest）が17件すべて通ることと、型チェック（`npm run typecheck`）が通ることを確かめた。

| ファイル | 変更 |
|---|---|
| `src/lib/x402-route.ts` | `withSolanaOnlyPaywall` の中で、`withX402` の応答に `PAYMENT-RESPONSE`（`success: true`）があれば1件記録する。支払いの処理は変えない。記録に失敗しても応答は返し、`console.error` に残す |
| `src/lib/sales-log.ts`（新規） | Upstash Redis の REST に、JST の日付ごと（`jin:sales:YYYY-MM-DD`）に `RPUSH` する。400日で消える。KV が未設定なら何もしない |
| `src/app/sales/[date]/route.ts`（新規） | `GET /sales/:date`。`SELLER_LOG_TOKEN`（32文字以上）の Bearer が一致したときだけ、その日の配列を返す。未設定・短いときは 404、記録が無い日は 404 |
| `tests-ts/sales-log.test.ts`（新規） | 記録の中身、未払い・settle 失敗で記録しないこと、記録の失敗で応答が止まらないこと、認証 |

当て方（JIN のリポジトリで）：

```sh
git apply /path/to/poc-dual-checkout/docs/patches/jin-seller-log.patch
npm test && npm run typecheck
```

JIN の Vercel に入れる環境変数：

| 名前 | 中身 |
|---|---|
| `SALES_LOG_KV_REST_URL` / `SALES_LOG_KV_REST_TOKEN` | Upstash Redis（Vercel Marketplace）の REST の URL とトークン（読み書き） |
| `SELLER_LOG_TOKEN` | 実証2が読むための読み取り専用トークン（32文字以上の乱数。例：`openssl rand -hex 32`） |

実証2の GitHub Secrets には、`SELLER_LOG_URL` = `https://jin.x402jp.com`（`/sales/:date` は自動で付く）と、同じ `SELLER_LOG_TOKEN` を入れる。JIN の口が動き始めたら、その日付を `usdc.seller_log_since` に入れてから `node scripts/collect-daily.mjs --resummarize <開始日>..<終了日>` を実行する。`seller_log_since` より前の日の $0.01 は「不明」のまま残る（AA の分は AA の公開 run ログで確定する）。

注意：JIN のログを書き損ねた支払いは、その日のログが取れている限り「ログに無い $0.01」＝ OSD と判定される。JIN 側の `[sales-log] 記録に失敗` のログが出ていないかを確かめる。
