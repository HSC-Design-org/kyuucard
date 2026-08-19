const { chromium } = require('playwright');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://www.enecho.meti.go.jp/statistics/petroleum_and_lpgas/pl007/results.html';
const SHEET_NAME = '公表資料（都道府県別）';

// Column mapping for "結果詳細版" (260430.xlsx) format
// Row 5 has the header text, Row 6 has the dates (Excel serial), Rows 7+ have data.
// Each fuel has two columns: previous week / current week. We use current week.
const FUEL_COLUMNS = {
  'ハイオク':   { current: 'D', date: 'D6' },
  'レギュラー': { current: 'F', date: 'F6' },
  '軽油':       { current: 'H', date: 'H6' },
  '灯油店頭':   { current: 'J', date: 'J6' },
  '灯油配達':   { current: 'L', date: 'L6' },
};

const DATA_ROW_START = 7;   // 北海道局
const DATA_ROW_END   = 61;  // 九州沖縄局 (row 62 is 全国, exclude)
// 念のため名前ベースでも除外: 「全国」「全 国」など空白入りの可能性に対応
const EXCLUDE_NAME_PATTERN = /^全\s*国$/;

(async () => {
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' },
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  console.log(`Navigating to ${SOURCE_URL}`);
  await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Find the 結果詳細版 link (basic ~30KB xlsx, not the 2.5MB s5 weekly file)
  const xlsxUrl = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(a =>
      a.href && a.href.includes('.xlsx') && /結果詳細版/.test(a.innerText)
    );
    return link ? link.href : null;
  });
  if (!xlsxUrl) throw new Error('結果詳細版 xlsx link not found');
  console.log(`Latest xlsx: ${xlsxUrl}`);

  // Download the xlsx via a real browser navigation (full Akamai/browser stack).
  // ページ内 fetch() は 2026-07 頃から Akamai に弾かれ 0 バイトで返るようになったため、
  // ブラウザのダウンロード機構経由（クッキー・TLS・ヘッダすべて本物）に変更した。
  await page.waitForTimeout(2000); // Akamai センサー送信を待つ
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    // xlsx への遷移は download 扱いになり goto が reject するので握りつぶす
    page.goto(xlsxUrl, { timeout: 60000 }).catch(() => {}),
  ]);
  const dlPath = await download.path();
  const xlsxBuffer = fs.readFileSync(dlPath);
  console.log(`Downloaded ${xlsxBuffer.length} bytes`);
  // 0バイト/極小はブロックされた証拠。空ファイルをパースして誤データを書かないよう明示的に失敗させる。
  if (xlsxBuffer.length < 5000) {
    throw new Error(`xlsx too small (${xlsxBuffer.length} bytes) — download likely blocked by Akamai`);
  }

  await browser.close();

  const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) throw new Error(`Sheet not found: ${SHEET_NAME}`);

  const cacheData = {
    timestamp: Math.floor(Date.now() / 1000),
    source_url: xlsxUrl,
    sheets: {},
  };

  for (const [fuelName, conf] of Object.entries(FUEL_COLUMNS)) {
    const dateCell = ws[conf.date];
    const date = parseExcelDate(dateCell ? dateCell.v : null);

    const data = {};
    for (let r = DATA_ROW_START; r <= DATA_ROW_END; r++) {
      const nameCell = ws[`B${r}`];
      const valueCell = ws[`${conf.current}${r}`];
      if (!nameCell || nameCell.v == null) continue;
      const name = String(nameCell.v).trim();
      if (!name) continue;
      // 「全国」行を除外（行範囲指定とのダブルチェック）
      if (EXCLUDE_NAME_PATTERN.test(name.replace(/[\s　]+/g, ''))) continue;
      const v = valueCell ? valueCell.v : null;
      if (v == null) continue;
      data[name] = (typeof v === 'number') ? Math.round(v * 10) / 10 : v;
    }

    cacheData.sheets[fuelName] = { date, data };
    console.log(`  ${fuelName}: date=${date}, entries=${Object.keys(data).length}`);
  }

  const outPath = path.join(__dirname, 'data.json');
  // 実データ（source_url と価格表）に変更がなければ書き換えない。
  // timestamp は毎回変わるため、これを含めて比較すると毎回コミットが発生してしまう。
  if (fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (prev.source_url === cacheData.source_url &&
        JSON.stringify(prev.sheets) === JSON.stringify(cacheData.sheets)) {
      console.log('No data change; keeping existing data.json');
      return;
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(cacheData, null, 2));
  console.log(`Wrote ${outPath}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

function parseExcelDate(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && raw > 40000) {
    const d = XLSX.SSF.parse_date_code(raw);
    if (!d) return '';
    return `${d.y}年${String(d.m).padStart(2, '0')}月`;
  }
  const s = String(raw);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}年${m[2].padStart(2, '0')}月`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}年${m[1].padStart(2, '0')}月`;
  return '';
}
