// Rule-level regression tests. These are the parts that decide what the board
// shows, and they are the parts most likely to drift when a broker rewords a
// page — so they get pinned here with real strings taken off the live sites.
import assert from 'node:assert/strict';
import { classify, confirm, preScreen } from './lib/classify.mjs';
import { pickPeriod, pickRewards, pickTitle } from './lib/extract.mjs';
import { canonicalUrl, cleanBlock, clean, statusOf } from './lib/util.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n   ${err.message.split('\n')[0]}`);
  }
}

const period = (raw) => {
  const block = cleanBlock(raw);
  return pickPeriod(block, clean(block));
};

/* ---------- period ---------- */

test('活動期間在下一行也讀得到', () => {
  const p = period('注意事項\n活動時間\n\n2026/04/15～2026/12/31\n活動說明');
  assert.equal(p.start, '2026-04-15');
  assert.equal(p.end, '2026-12-31');
});

test('後半段省略年份時沿用前半段', () => {
  const p = period('活動期間：2026/08/01 — 12/31');
  assert.equal(p.start, '2026-08-01');
  assert.equal(p.end, '2026-12-31');
});

test('跨年的省略年份會進位', () => {
  const p = period('活動期間 2026/11/01 ~ 02/28');
  assert.equal(p.start, '2026-11-01');
  assert.equal(p.end, '2027-02-28');
});

test('民國年', () => {
  const p = period('活動期間完成開戶 115/1/1-7/31');
  assert.equal(p.start, '2026-01-01');
  assert.equal(p.end, '2026-07-31');
});

test('中文年月日', () => {
  const p = period('活動期間 2026年6月1日至2026年8月31日');
  assert.equal(p.start, '2026-06-01');
  assert.equal(p.end, '2026-08-31');
});

test('沒有期間就回 null，不亂猜', () => {
  const p = period('本活動適用統一證券及統一期貨客戶，同ID口數合併計算。');
  assert.equal(p.start, null);
  assert.equal(p.end, null);
});

test('優先採用「活動期間」而非頁面上其他日期', () => {
  const p = period('最後交易日 2026/09/17\n\n活動期間\n2026/06/15 — 2026/09/15\n開獎 2026/10/01');
  assert.equal(p.start, '2026-06-15');
  assert.equal(p.end, '2026-09-15');
});

// 華南 賞金盛典 改版後，舊檔期以「資格定義」的形式留在頁面較前面的位置，
// 依出現順序讀會讀到舊的，把還在跑的活動判成已結束。
test('標題形式的活動期間，勝過句中引用的舊檔期', () => {
  const p = period(
    [
      '*全新戶定義:活動期間完成開戶者,即為全新戶',
      '*新動用戶定義: 活動期間全新戶或115/1/1-7/31未交易國內外期權商品之靜止戶。',
      '注意事項',
      '活動期間:',
      '115年08月01日起至11月30日止(共4個月)。',
      '活動商品:',
    ].join('\n')
  );
  assert.equal(p.start, '2026-08-01');
  assert.equal(p.end, '2026-11-30');
  // Decided by the heading rule, not a coin flip — so no uncertainty flag.
  assert.equal(p.ambiguous, false);
});

test('兩組同樣是標題形式的活動期間才算多義', () => {
  const p = period('活動期間:\n2026/01/01-2026/06/30\n活動期間:\n2026/08/01-2026/11/30');
  assert.equal(p.ambiguous, true);
});

test('只有一組期間時不標記為多義', () => {
  const p = period('活動期間：2026/08/01 — 12/31');
  assert.equal(p.ambiguous, false);
});

test('主期間加上週期性抽獎期間，不算多義', () => {
  const p = period('活動期間:\n2026/08/01-2026/12/31\n抽獎期間:\n2026/11/02-11/08');
  assert.equal(p.start, '2026-08-01');
  assert.equal(p.ambiguous, false);
});

test('無標籤時只接受完整區間，單一到期日不算活動期間', () => {
  const p = period('點數效期至 2025/12/31 止,逾期未使用視為放棄。');
  assert.equal(p.start, null);
  assert.equal(p.end, null);
});

// 永豐 海期掏金季：整段活動寫成「2026年7-12月」，而頁面另有一組
// 「2026/01/01~06/30 海外期貨無任何交易筆數,即符合靜戶定義」的資格日期。
test('整月區間 2026年7-12月', () => {
  const p = period('在2026年7-12月任 3 個月加總海期交易達 250 口,再加碼送你金豆1克!');
  assert.equal(p.start, '2026-07-01');
  assert.equal(p.end, '2026-12-31');
});

test('資格定義用的日期不會被當成活動期間', () => {
  const p = period(
    '首次在永豐期貨開戶,以身分證字號判斷。\n2026/01/01~06/30 海外期貨無任何交易筆數,即符合靜戶定義。\n' +
      '在2026年7-12月任 3 個月加總海期交易達 250 口。'
  );
  assert.equal(p.start, '2026-07-01');
  assert.equal(p.end, '2026-12-31');
});

test('「活動期間」勝過「抽獎期間」', () => {
  const p = period('抽獎期間:\n2026/12/01-12/31\n活動期間:\n2026/08/01-2026/12/31');
  assert.equal(p.start, '2026-08-01');
  assert.equal(p.end, '2026-12-31');
});

/* ---------- rewards ---------- */

test('讀出最高獎勵', () => {
  const { max } = pickRewards('首次海期交易總口數達30口送666元獎勵金(手續費抵用金)。');
  assert.equal(max, 666);
});

test('萬元換算', () => {
  const { max } = pickRewards('每月獎池 NT$10萬 好禮，月底結算後開獎');
  assert.equal(max, 100000);
});

test('年份不會被當成金額', () => {
  const { max } = pickRewards('凱基期貨好禮 活動時間 2026/04/15~2026/12/31');
  assert.equal(max, null);
});

test('口數門檻不會被當成金額', () => {
  const { max } = pickRewards('交易滿 388 口＋指定 5 類商品，獎勵加碼');
  assert.equal(max, null);
});

test('保證金與稅額不算獎勵', () => {
  const { max } = pickRewards('獎項超過新台幣20000元本公司將代扣繳10%所得稅');
  assert.equal(max, null);
});

test('沒有幣別標記的數字不算', () => {
  const { max } = pickRewards('好禮 12345678 序號');
  assert.equal(max, null);
});

/* ---------- title ---------- */

test('去掉品牌前綴', () => {
  const t = pickTitle({ title: '元大期貨｜2026 股期積分爭霸賽', h1: [] }, {});
  assert.equal(t, '2026 股期積分爭霸賽');
});

test('全形標點保留（NFKC 會吃掉，所以標題走 NFC）', () => {
  const t = pickTitle({ title: '凱基期貨｜登記享專人開戶陪跑，最高領 $1700 交易應援金！', h1: [] }, {});
  assert.ok(t.includes('，'), t);
  assert.ok(t.endsWith('！'), t);
});

test('只有公司名的標題不採用，改用 h1', () => {
  const t = pickTitle({ title: '台新期貨', h1: ['海外期 下台新'] }, {});
  assert.equal(t, '海外期 下台新');
});

/* ---------- screening ---------- */

const broker = { id: 'x', name: 'X', home: 'https://www.example.com.tw/', eventPatterns: [/\/promo\//i] };

test('登入頁不進候選', () => {
  assert.equal(preScreen({ url: 'https://a.example.com.tw/sign/login.html?r=Adventure', label: '活動查詢', pic: 'p.png', area: 'body' }, broker), null);
});

test('社群連結不進候選', () => {
  assert.equal(preScreen({ url: 'https://www.facebook.com/x', label: '活動', pic: 'p.png', area: 'carousel' }, broker), null);
});

test('期貨商自己的首頁不進候選', () => {
  assert.equal(preScreen({ url: 'https://www.example.com.tw/index.html', label: '活動', pic: 'p.png', area: 'carousel' }, broker), null);
});

test('反詐騙專區不進候選', () => {
  assert.equal(preScreen({ url: 'https://www.example.com.tw/anti-fraud/', label: '反詐騙專區', pic: 'p.png', area: 'carousel' }, broker), null);
});

test('活動路徑進候選並標記 onEventUrl', () => {
  const c = preScreen({ url: 'https://www.example.com.tw/promo/2026/', label: '', pic: 'bn.jpg', area: 'carousel' }, broker);
  assert.equal(c.hints.onEventUrl, true);
});

/* ---------- classification ---------- */

const candidate = { url: 'https://www.example.com.tw/promo/a/', label: '', pic: 'bn.jpg', area: 'carousel', hints: { onEventUrl: true, labelHints: false, heroBanner: true } };

test('得獎新聞稿不算活動', () => {
  const v = classify(candidate, {
    title: '雙冠榮耀！凱基期貨榮獲期貨鑽石獎第一名',
    h1: [],
    text: '榮獲肯定，持續舉辦活動滿足小資族群需求並提升市場參與度，優惠回饋。',
    via: 'http',
  });
  assert.equal(v.ok, false);
});

test('產品說明頁沒有活動辦法字樣就不算活動', () => {
  const v = classify(candidate, {
    title: '「程式交易」教學網：MultiCharts、API',
    h1: [],
    text: '認識 MultiCharts，程式交易有什麼優點，免費下載，優惠回饋。'.repeat(20),
    via: 'http',
  });
  assert.equal(v.ok, false);
});

test('真活動頁分類為 promo', () => {
  const v = classify(candidate, {
    title: '2026 股期積分爭霸賽',
    h1: [],
    text: '活動期間 2026/06/15—2026/09/15。本活動以每人（ID 歸戶）計。獎項：享樂券。得獎名單將公布。抽獎機會。贈品說明，代扣繳10%所得稅。',
    via: 'http',
  });
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'promo');
});

test('共用頁尾帶來的活動字樣，沒期間又沒活動名稱時會被 confirm 擋掉', () => {
  const v = classify(candidate, {
    title: '為什麼來統一期貨交易股票期貨 ?',
    h1: ['專業軟體功能'],
    text: '活動期間依公告。得獎名單另行公布。本活動贈品說明。立即參加。',
    via: 'http',
  });
  const fields = { title: '為什麼來統一期貨交易股票期貨 ?', period: { start: null, end: null } };
  assert.equal(confirm(v, fields, candidate, { h1: ['專業軟體功能'] }).ok, false);
});

test('沒讀到期間但名稱像活動就保留', () => {
  const v = { ok: true, confidence: 'high', kind: 'promo', thin: false };
  const fields = { title: '統一期貨「2026國內期貨交易達標尊享禮」', period: { start: null, end: null } };
  const out = confirm(v, fields, candidate, { h1: [] });
  assert.equal(out.ok, true);
  assert.equal(out.confidence, 'medium');
});

test('只有舊發佈日期就判定已過期', () => {
  const v = { ok: true, confidence: 'low', kind: 'info', thin: true };
  const fields = { title: '什麼都 下台新', period: { start: '2023-01-01', end: null, source: 'url' } };
  assert.equal(confirm(v, fields, candidate, { h1: [] }).ok, false);
});

/* ---------- status & url ---------- */

test('網址日期不會讓活動變成進行中', () => {
  assert.equal(statusOf({ start: '2026-07-01', end: null, source: 'url' }), 'unknown');
});

test('真期間才判進行中／已結束', () => {
  assert.equal(statusOf({ start: '2000-01-01', end: '2000-02-01' }), 'ended');
  assert.equal(statusOf({ start: '2000-01-01', end: '2999-01-01' }), 'active');
  assert.equal(statusOf({ start: '2999-01-01', end: '2999-02-01' }), 'upcoming');
});

test('追蹤參數不影響活動識別', () => {
  assert.equal(
    canonicalUrl('https://a.tw/event/?utm_source=web&utm_campaign=x&EmpNo=market&id=7'),
    'https://a.tw/event/?id=7'
  );
});

console.log(`\n${passed} 通過${failed ? `，${failed} 失敗` : ''}`);
process.exit(failed ? 1 : 0);
