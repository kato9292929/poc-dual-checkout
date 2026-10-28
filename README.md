# poc-dual-checkout — 実証2：JIN を USDC の x402 とカード払いの両方で売る（型P）

Japan Inflation Nowcall（JIN）の同じデータ（`series` / `movers`）を、2つの入口で同じ単価で売る。手数料・着金までの時間・購入者の内訳が、入口によってどう違うかを測る。

どちらの入口も、買い手のエージェントには x402 の支払い要求（402）として見える。違うのは決済の通り道。

| 入口 | 中身 | 決済の通り道 |
|---|---|---|
| USDC 直接 | 既存の `jin.x402jp.com`（変更しない） | チェーン上で USDC が直接動く |
| カード払い | 実証1（`poc-card-credits`）のゲートウェイ ＋ Nevermined のカードプラン | Stripe 経由でカード決済 |

Nevermined のプランはカードか暗号資産のどちらか一方しか持てないので、Nevermined にはカードプランだけを置く。本リポジトリが作るのは **販売ページ・ページ計測・所要時間の計測・日次集計・週次レポート** だけ。

## 価格（期間中は変えない）

| データ | USDC 直接 | カード（前払い） |
|---|---|---|
| `series` | $0.01 / call | 1 クレジット |
| `movers` | $0.02 / call | 2 クレジット |
| プラン | — | $1 で 100 クレジット（1 クレジット = $0.01） |

カードは前払い（`prepaid`）に固定する。都度払い（pay-as-you-go）は、Stripe の最低請求額 $0.50 があるので使わない。プランの購入ページが未設定の間、販売ページのカード入口は「準備中」と表示される。

価格は `config/site.json`、期間開始時の固定値は `config/period.json`。日次集計のたびに、入口どうしの単価と固定値を照合する。食い違えば日次データの `price_check` に `mismatch` を残し、週次レポートの冒頭に警告を出す。

## 構成

| パス | 役割 |
|---|---|
| `site/index.template.html`, `scripts/build-site.mjs` | 販売ページ（`config/site.json` から `public/index.html` を生成） |
| `api/track.js`, `api/stats.js` | ページ計測（Cookie なし）。閲覧数と、各入口の説明を開いた回数を日ごとに数える（Upstash Redis。下の「外部サービスの依存」） |
| `scripts/probe-latency.mjs` | 決済1件の所要時間を、両方の入口で同じ手順で測る |
| `scripts/collect-daily.mjs` | 日次集計 → `data/YYYY-MM-DD.json` |
| `scripts/report-weekly.mjs` | 週次レポート → `reports/YYYY-Www.md` |
| `config/own_wallets.json` | 自社の支払い元（公開アドレス・トークン ID）→ own |
| `config/external_buyers.json` | 外部と確定した購入者 → external（どちらにも一致しないものは unclassified。変更履歴: `config/CHANGELOG.md`） |
| `data/stripe/YYYY-MM.csv` | 手で書き出した Stripe の CSV（置いてよい列は `data/stripe/README.md`） |
| `docs/sources.md` | 各数字の出典、計測方法、未確認の点 |
| `docs/seller-log.md` | 売り手側の「エンドポイント ↔ tx 署名」ログの形式（$0.01 を JIN と OSD に振り分ける） |

## 外部サービスの依存：Upstash Redis（指示書に無い依存）

販売ページの計測（閲覧数と、各入口の説明を開いた回数）を日ごとに数えるためだけに使う。Vercel の関数は状態を持てないので、件数を置く場所として使っている。日次集計・週次レポートのほかの数字（チェーン、Stripe、実証1のログ、Nevermined）には関わらない。

| 使っている箇所 | 用途 | Redis のコマンド |
|---|---|---|
| `lib/track.js` の `redis()` | Upstash の REST API（`POST {UPSTASH_REDIS_REST_URL}/pipeline`）を呼ぶ唯一の関数。依存パッケージは入れていない | — |
| `api/track.js`（`POST /api/track`） | ページからのイベントを1件受けるたびに、その日（JST）のカウンタを1増やす。400日で自動的に消える | `INCR`、`EXPIRE` |
| `api/stats.js`（`GET /api/stats?date=`、Bearer `STATS_TOKEN`） | 日次集計がその日のカウンタを読む | `MGET` |
| `scripts/collect-daily.mjs` | `STATS_URL` 経由で `api/stats` を呼ぶ（Upstash には直接つながない） | — |

- 置いているのは、`jin:YYYY-MM-DD:view`、`jin:YYYY-MM-DD:open:usdc`、`jin:YYYY-MM-DD:open:card` の3種類の件数だけ。IP アドレス、UA、Cookie、閲覧者の ID は送らないし、保存もしない。
- 環境変数は `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`（Vercel 側だけ）。
- Upstash が無い・落ちているとき：`/api/track` は 503 を返して何も数えない（ページの表示には影響しない）。日次集計では `sources.page` が `error: …` または `not_configured` になり、販売ページの数字は空のまま残る（0 では埋めない）。
- 別のものに替えるときは `lib/track.js` の `redis()` だけを差し替えればよい（`INCR`・`EXPIRE`・`MGET` 相当があれば足りる）。

## 集計項目

| 項目 | USDC 直接 | カード払い |
|---|---|---|
| 成約件数 | JIN への支払い件数（下限〜上限。受取口座を OSD と共有していて、$0.01 は JIN の series か OSD か区別できないため。`docs/seller-log.md`） | プラン購入件数（主系は `card.purchase_source`：`stripe`〔既定〕/ `nvm_events`） |
| 利用回数 | 支払い件数 | 消費クレジット数（実証1ゲートウェイのログ） |
| 購入者数 | 支払い元アドレス数 | 匿名化したトークン ID の数（同上） |
| 1件あたりの手数料 | チェーン手数料のうち seller が払った分（facilitator の分は参考値として別の列） | カード手数料（実測） |
| 手数料率 | 売上に対する割合（同上） | 売上に対する割合 |
| 決済1件の所要時間 | リクエストから 200 まで | リクエストから 200 まで |
| 着金までの日数 | 即時 | Stripe Connect の入金日 |

日次の区切りは JST の 00:00〜24:00。各トランザクションには UTC の時刻と JST の日付の両方を記録する。Nevermined の Events & Analytics は照合用で、403 などで取れない日は `nvm_api: "unavailable"` と記録して続ける。Stripe のキーが無い日は、手数料と着金日を null にして `stripe: "missing"` と記録する。

購入者は3つに分ける。

| 区分 | 条件 | レポート |
|---|---|---|
| own | `config/own_wallets.json` に一致（実証1ゲートウェイの裏側の JIN 購入を含む） | 参考値の別表。全集計から除外 |
| external | `config/external_buyers.json` に一致（外部と確定） | 本表 |
| unclassified | どちらにも一致しない。自動で external にはしない | 別表（支払い元の一覧付き） |

分類は日次データの明細に対して集計のたびに当て直すので、リストを直したら過去の日も数え直せる（`--resummarize`）。外部の購入者がいない週は、レポートの冒頭にそう書く。

保存するのは、ウォレットアドレスと匿名化した ID（Nevermined の userId、Stripe の取引 ID、実証1の payerId）だけ。

## 立ち上げ手順

実証1が Sandbox で動いてから始める。

1. **カード入口を設定する**：`config/site.json` の `nvm_plan_id`、`nvm_agent_id`、`plan_purchase_url`、`gateway_base_url`、`stripe_match`。プランの受取先（`nvm_receiver_address`）は Nevermined の売り手ウォレット `0x6d56…43Ed5` を入れてある。
2. **自社の支払い元を書く**：`config/own_wallets.json` の `address: null` を埋める（公開アドレスだけ）。AA は確定済み。Seller Probe は設定に公開アドレスが無いので未取得。実証1ゲートウェイのウォレット（`3HG2…rcgV`）は追加済み。実証1の検証用買い手と計測用の買い手のトークン ID（実証1のログの `tokenId`）を `card_token_ids` に入れる。`version` を上げて `CHANGELOG.md` に記録し、`--resummarize` で数え直す。
3. **実証1ゲートウェイのログの口（`GET /logs/:date`）につなぐ**：`gateway_base_url` は設定済み。実証1の `LOG_READ_TOKEN` を Secrets に入れる。それまでの日は欠損（`gateway_log: "missing"`）として記録されるので、つながったら `--resummarize` で数え直す（`docs/sources.md`）。
4. **販売ページをデプロイ**：手順と本人の作業は `docs/launch.md` の表にまとめた。公開した日は `config/site.json` の `page.published_on` に入れる。カードの購入ボタンは、実証1が本番（Live）に移ってプラン ID が入るまで「準備中」のまま。
5. **GitHub Secrets を設定**：`.env.example` の集計用と計測用の値。
6. **期間**：P1 は 2026-10-22〜11-18（2026-10-28 に決定、さかのぼって適用）。期間は延ばさない。4週間は価格を変えない。

以降は GitHub Actions が動く。日次・週次の Action は既定ブランチ（`main`）で動き、`main` にコミットする。

- `daily`：毎日 06:13 JST に所要時間を測り、前日分を `data/` にコミットする
- `weekly-report`：毎週月曜 07:07 JST に前週分を `reports/` にコミットする

手で回すときは次のとおり。

```sh
npm ci
npm test
npm run build                                          # public/index.html
node scripts/probe-latency.mjs
node scripts/collect-daily.mjs --date 2026-11-03
node scripts/collect-daily.mjs --resummarize 2026-10-12..2026-11-28
node scripts/collect-daily.mjs --upgrade          # 旧形式の日次データを現行の形式（schema_version）に数え直す
node scripts/report-weekly.mjs --week 2026-W45
```

## 未確認・要確認

- Seller Probe の Solana の公開アドレス（`config/own_wallets.json` が pending）。AA は `7PVT…L6tY` で確定済み（aa.x402jp.com/api/runs の tx 署名から。`docs/sources.md`）
- 実証1ゲートウェイのログの口（`GET /logs/:date`）と `LOG_READ_TOKEN`
- JIN の売り手ログの口（`GET /sales/:date`）。JIN の PR #10 が未マージで、まだ動いていない（2026-10-18 時点）。動き始めた日を `config/site.json` の `usdc.seller_log_since` に入れるまで、$0.01 は JIN の series か OSD か「不明」のまま残る（`docs/seller-log.md`）
- Nevermined の組織が Premium 以上か（照合用。無くても集計は止まらない）
- Stripe Connect の形（Standard / Express）と、制限付きキーを発行できるか（できなければ CSV）

## やらないこと

- `jin.x402jp.com` の x402 実装の変更、他のリポジトリ（AA・seller-probe・JIN・OSD・実証1）への書き込み（例外：売り手ログの記録だけは JIN に PR を出した。支払いの処理は変えず、settle 後に1件記録するだけ。`docs/seller-log.md`）
- 購入者を特定できる個人情報の保存
- 期間中の価格変更
