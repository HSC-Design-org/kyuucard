# kyuucard-data

[kyuucard.net](https://kyuucard.net/) の地域別給油価格ランキング用データを自動取得するリポジトリです。

## 仕組み

経済産業省 資源エネルギー庁の[石油製品価格調査](https://www.enecho.meti.go.jp/statistics/petroleum_and_lpgas/pl007/results.html)ページは Akamai Bot Manager で保護されており、サーバ（PHP/curl）からは直接取得できません。

そのため GitHub Actions 上で **Playwright（ヘッドレスChrome）** を起動して人間と同様のリクエストを行い、最新の週次xlsxを取得 → JSONに変換してこのリポジトリにcommitします。

kyuucard.net 側は `https://raw.githubusercontent.com/HSC-Design-org/kyuucard/main/data.json` を取得するだけ。

## ファイル

- `scrape.js` — Playwrightで経産省サイトから最新xlsxを取得しJSON化するスクリプト
- `.github/workflows/scrape.yml` — 毎週月曜09:00 JST に実行するワークフロー
- `data.json` — 最新の取得データ（Actionsが自動更新）

## 手動実行

GitHubの Actions タブから `Scrape weekly fuel prices` ワークフローを開き「Run workflow」で即時実行できます。
