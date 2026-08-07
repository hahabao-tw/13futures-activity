import { clean, cleanBlock, cleanDisplay, toISODate } from './util.mjs';

/**
 * Everything the site shows about a campaign beyond its title comes from here.
 * No model is involved, so the rules have to be honest about failing: when a
 * field cannot be read the campaign keeps it null and the card falls back to
 * showing the banner image, which is what a human would read anyway.
 */
export function extract(page, candidate) {
  const text = cleanBlock(page?.text ?? '');
  const flat = clean(text);
  const title = pickTitle(page, candidate);
  const read = pickPeriod(text, flat);
  const period = read.start || read.end ? read : (datedFromUrl(candidate) ?? read);
  // The headline figure is regularly only in the page title ("最高領 $1700 交易
  // 應援金"), because the body breaks the same prize into its parts.
  const rewards = pickRewards(`${title} 好禮 ${flat}`);
  return {
    title,
    period,
    audience: pickAudience(flat),
    products: pickProducts(flat, title),
    rewards: rewards.list,
    maxValue: rewards.max,
    missing: [
      // A URL-derived date is a publication date, so the period still counts as
      // unread and the campaign still shows up on the 待補 list.
      period.source === 'url' || (!period.start && !period.end) ? 'period' : null,
      rewards.max == null ? 'reward' : null,
    ].filter(Boolean),
  };
}

/**
 * Landing-page <title> is the single most reliable field on these pages: the
 * campaign name is baked into the banner image, but the same wording is almost
 * always in the title tag, often with the headline reward attached
 * ("凱基期貨｜登記享專人開戶陪跑，最高領 $1700 交易應援金！").
 */
export function pickTitle(page, candidate) {
  const strip = (s) =>
    cleanDisplay(s ?? '')
      .replace(/^[｜|\-–—·]+|[｜|\-–—·]+$/g, '')
      .trim();

  const raw = strip(page?.title);
  const cleaned = dropBrandTail(raw);
  if (usable(cleaned)) return cleaned;

  for (const h of page?.h1 ?? []) {
    const t = strip(h);
    if (usable(t)) return t;
  }
  const label = strip(candidate?.label);
  if (usable(label)) return label;
  if (usable(raw)) return raw;

  // Last resort: the banner file name, which brokers name after the campaign
  // (0416_run-global_mb.jpg, 2026股期在元大.png).
  const file = strip(
    decodeURIComponent(candidate?.pic ?? '')
      .split('/')
      .pop()
      ?.replace(/\.(jpg|jpeg|png|gif|webp|svg)$/i, '')
      .replace(/[_-]+/g, ' ')
  );
  return usable(file) ? file : raw || label || '(未命名活動)';
}

function usable(s) {
  if (!s || s.length < 4 || s.length > 90) return false;
  if (/^(首頁|home|index|untitled)$/i.test(s)) return false;
  // A page whose <title> is just the company name tells us nothing; fall through
  // to the heading or the banner label instead.
  return !/^[一-龥]{2,4}(期貨|證券|投顧|金控)(股份有限公司|網)?$/.test(s);
}

/** "元大期貨｜2026 股期積分爭霸賽" -> "2026 股期積分爭霸賽" */
function dropBrandTail(title) {
  if (!title) return '';
  const parts = title.split(/[｜|]|\s[-–—]\s/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return title;
  const brandish = /期貨|證券|金控|官網|股份有限公司/;
  const meaty = parts.filter((p) => !(brandish.test(p) && p.length <= 12));
  return meaty.length ? meaty.join(' ').trim() : title;
}

const DATE = String.raw`(?:民國\s*)?(?:1\d{2}|20\d{2})\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?`;
const SHORT = String.raw`\d{1,2}\s*[/.月]\s*\d{1,2}\s*日?`;
const SEP = String.raw`\s*(?:~|～|-|–|—|至|到|起至|＿|,)\s*`;
/** "2026年7-12月" — a whole-month campaign window, common on 永豐's pages. */
const MONTH_RANGE = String.raw`(20\d{2})\s*年\s*(\d{1,2})\s*[-–—~～至]\s*(\d{1,2})\s*月`;

/**
 * Dates quoted to define who may take part, not when the campaign runs.
 * 永豐's 掏金季 page says "2026/01/01~06/30 海外期貨無任何交易筆數,即符合靜戶定義"
 * — that is the dormant-account test for a campaign that actually runs 7-12月.
 */
const DEFINITION_CONTEXT =
  /(定義|資格|未曾交易|未有交易|無任何交易|從未|靜止戶|靜戶|舊戶|舉例|例如|即符合|視同|排除)/;

const PERIOD_LABEL = /(?:活動|報名|抽獎|競賽|任務|贈獎)(?:期間|時間|日期|起訖)/g;

/** 活動期間 outranks 報名期間 outranks 抽獎期間 when a page states several. */
function labelWeight(label) {
  if (/^活動/.test(label)) return 3;
  if (/^(競賽|任務|贈獎)/.test(label)) return 2;
  return 1;
}

/**
 * Period is read from windows following a 活動期間-style label, because these
 * pages are full of other dates (開獎日, 最後交易日, 結算日).
 *
 * The hard part is that the label itself appears many times, and only one of
 * those is the heading that introduces the period. 華南's 賞金盛典 page says
 * "活動期間:" once — followed by the current 115/08/01–11/30 — and then uses the
 * same two characters mid-sentence eight more times, including
 * "*新動用戶定義: 活動期間全新戶或115/1/1-7/31未交易…", which is last season's
 * dates quoted as an eligibility rule. Reading in document order picked that one
 * up and buried a running campaign as 已結束.
 *
 * So every labelled window is collected and then ranked. A heading is followed by
 * a colon or a line break; prose runs straight on into more characters. That one
 * distinction separates the real period from every quoted date on the page.
 */
export function pickPeriod(text, flat) {
  const found = [];
  for (const m of text.matchAll(PERIOD_LABEL)) {
    const at = m.index + m[0].length;
    const after = text.slice(at, at + 90);
    const range = parseRange(after);
    if (!range.start && !range.end) continue;
    found.push({
      ...range,
      label: m[0],
      heading: /^\s*[：:︰\n]/.test(after),
      weight: labelWeight(m[0]),
      definitional: DEFINITION_CONTEXT.test(after.slice(0, 70)),
    });
  }

  if (found.length) {
    const ranked = rank(found);
    const best = ranked[0];
    return {
      start: best.start,
      end: best.end,
      raw: `${best.label} ${best.raw}`.trim(),
      source: 'labelled',
      ambiguous: isCoinFlip(ranked),
    };
  }

  // Nothing labelled. Scanning for "the first range on the page" is what used to
  // happen, and it is how an eligibility window got read as a campaign period —
  // so every range is collected and the definitional ones are dropped instead.
  // An unlabelled range only counts when it is a complete one. A lone end date
  // picked off a page is far more likely to be a points expiry or a deadline than
  // a campaign period — 群益's 贏家名人堂 points programme is exactly that.
  const scanned = scanRanges(flat).filter((r) => !r.definitional && r.start && r.end);
  if (scanned.length) {
    const ranked = rank(scanned);
    const best = ranked[0];
    return { start: best.start, end: best.end, raw: best.raw, source: 'scan', ambiguous: isCoinFlip(ranked) };
  }
  return { start: null, end: null, raw: null, source: null };
}

/**
 * Whether the choice between the top two readings was arbitrary. Campaign pages
 * legitimately carry several ranges — a 活動期間 plus weekly 抽獎期間 windows —
 * and flagging all of those as uncertain would make the warning meaningless. It
 * only counts when the runner-up was equally well-evidenced and says something
 * different.
 */
function isCoinFlip(ranked) {
  const [a, b] = ranked;
  if (!b) return false;
  if (a.start === b.start && a.end === b.end) return false;
  return Boolean(a.heading) === Boolean(b.heading) && (a.weight ?? 0) === (b.weight ?? 0);
}

function rank(list) {
  return [...list].sort(
    (a, b) =>
      Number(Boolean(b.heading)) - Number(Boolean(a.heading)) ||
      Number(Boolean(a.definitional)) - Number(Boolean(b.definitional)) ||
      (b.weight ?? 0) - (a.weight ?? 0) ||
      // A refreshed campaign page keeps last season's dates around as reference;
      // the current run is always the later one.
      (b.end ?? b.start ?? '').localeCompare(a.end ?? a.start ?? '')
  );
}

/**
 * The sentence a range sits in. A fixed character window is not good enough:
 * on 永豐's page the campaign window and the dormant-account definition are two
 * sentences apart, so a ±40 window drags "未曾交易" onto the wrong one and throws
 * away the only usable period the page has.
 */
function sentenceAround(text, index, length) {
  const breaks = /[。！!？?；;\n]/;
  let from = index;
  while (from > 0 && !breaks.test(text[from - 1]) && index - from < 120) from--;
  let to = index + length;
  while (to < text.length && !breaks.test(text[to]) && to - index < 160) to++;
  return text.slice(from, to);
}

/** Every date range on the page, each judged against the sentence it sits in. */
function scanRanges(flat) {
  const re = new RegExp(
    `(?:${MONTH_RANGE})|(?:${DATE}${SEP}${DATE})|(?:${DATE}${SEP}${SHORT})|(?:即日起${SEP}?${DATE})|(?:${SHORT}${SEP}${SHORT})`,
    'g'
  );
  const out = [];
  for (const m of flat.matchAll(re)) {
    const range = parseRange(m[0]);
    if (!range.start && !range.end) continue;
    out.push({ ...range, definitional: DEFINITION_CONTEXT.test(sentenceAround(flat, m.index, m[0].length)) });
  }
  return out;
}

/**
 * Last resort when the page states no period: brokers date their campaign folders
 * and banner files (EventWeb/20220118/, campaign/event/fubon_202607/,
 * bannerfiles/202608/…). That is not the campaign's period, but it does say when
 * the campaign was published, which is enough to tell a live campaign from one
 * still linked from a 2022 banner. Recorded as source 'url' so the site can say so.
 */
function datedFromUrl(candidate) {
  // A feed row already carries its publish date, which beats digging one out of
  // the URL.
  if (candidate?.date) {
    return { start: candidate.date, end: null, raw: `發佈於 ${candidate.date}`, source: 'url' };
  }
  const haystack = `${candidate?.url ?? ''} ${candidate?.pic ?? ''}`;
  const found = [...haystack.matchAll(/(?<!\d)(20[1-3]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])?(?!\d)/g)];
  if (!found.length) return null;
  const [, y, mo, d] = found[found.length - 1];
  const start = `${y}-${mo}-${d ?? '01'}`;
  return { start, end: null, raw: `依網址日期 ${start}`, source: 'url' };
}

function monthStart(y, mo) {
  const month = Number(mo);
  if (!(month >= 1 && month <= 12)) return null;
  return `${y}-${String(month).padStart(2, '0')}-01`;
}

function monthEnd(y, mo) {
  const month = Number(mo);
  if (!(month >= 1 && month <= 12)) return null;
  return new Date(Date.UTC(Number(y), month, 0)).toISOString().slice(0, 10);
}

function parseRange(window) {
  const year = new Date().getFullYear();

  // Before the day-level rules: "2026年7-12月" would otherwise be read by the
  // DATE pattern as 2026-07-12, because that pattern accepts "-" between month
  // and day.
  let m = new RegExp(MONTH_RANGE).exec(window);
  if (m) {
    const [, y, from, to] = m;
    return { start: monthStart(y, from), end: monthEnd(y, to), raw: clean(m[0]) };
  }

  m = new RegExp(`(${DATE})${SEP}(${DATE})`).exec(window);
  if (m) return { start: toISODate(m[1]), end: toISODate(m[2]), raw: clean(m[0]) };

  // "2026/08/01～12/31" — the second half inherits the year from the first.
  m = new RegExp(`(${DATE})${SEP}(${SHORT})`).exec(window);
  if (m) {
    const start = toISODate(m[1]);
    const startYear = start ? Number(start.slice(0, 4)) : year;
    let end = toISODate(m[2], { year: startYear });
    // A range that would run backwards has crossed a new year.
    if (start && end && end < start) end = toISODate(m[2], { year: startYear + 1 });
    return { start, end, raw: clean(m[0]) };
  }

  m = new RegExp(`(?:即日起|自即日)${SEP}?(${DATE})`).exec(window);
  if (m) return { start: null, end: toISODate(m[1]), raw: clean(m[0]) };

  m = new RegExp(`(${SHORT})${SEP}(${SHORT})`).exec(window);
  if (m) {
    const start = toISODate(m[1], { year });
    let end = toISODate(m[2], { year });
    if (start && end && end < start) end = toISODate(m[2], { year: year + 1 });
    return { start, end, raw: clean(m[0]) };
  }

  m = new RegExp(`(${DATE})`).exec(window);
  if (m) return { start: toISODate(m[1]), end: null, raw: clean(m[0]) };

  return { start: null, end: null, raw: null };
}

const REWARD_WORD =
  /(享樂券|即享券|禮券|禮金|回饋金|折抵金|抵用金|獎金|好禮|贈品|獎項|回饋|加碼|抽獎|中獎|折抵|現金|紅利|點數|凱期金|交易金|手續費)/;

/**
 * Money is everywhere on these pages — margins, contract values, worked examples.
 * Only amounts sitting next to reward vocabulary count, and 保證金/合約價值/成本
 * contexts are dropped outright.
 */
export function pickRewards(flat) {
  const list = [];
  let max = null;

  // The amount has to carry its own currency marker, either in front (NT$1,700)
  // or behind (1,700 元 / 10 萬元). Accepting a bare number because the sentence
  // mentioned 元 somewhere nearby reads "2026/04/15" as NT$2,026.
  const patterns = [
    /(?:NT\s*\$|新台幣|US\s*\$|\$)\s*([\d][\d,]{0,9})\s*(萬)?\s*元?/g,
    /([\d][\d,]{0,9})\s*(萬)?元/g,
  ];

  for (const money of patterns) {
    for (const m of flat.matchAll(money)) {
      const around = flat.slice(Math.max(0, m.index - 26), m.index + m[0].length + 26);
      if (!REWARD_WORD.test(around)) continue;
      if (/(保證金|合約價值|契約價值|成本|市值|股價|手續費為|扣繳|所得稅|稅款|損失|門檻|市價)/.test(around)) {
        continue;
      }
      // "交易滿 388 口" and "累積 50 分" are thresholds, not prizes.
      if (new RegExp(`${escape(m[1])}\\s*(口|分|股|張|次|名|位|席|%|％|年|月|日)`).test(around)) continue;
      // Years and licence numbers sit next to reward words often enough to matter.
      if (/^(19|20)\d{2}$/.test(m[1]) && !/\$/.test(m[0])) continue;

      // 萬 has to be applied before the floor, or "NT$10萬" is discarded as 10.
      let value = Number(m[1].replace(/,/g, '')) * (m[2] ? 10000 : 1);
      if (!Number.isFinite(value) || value < 50) continue;
      if (value > 5_000_000) continue; // pools this large are always a misread

      list.push({ value, context: clean(around).slice(0, 60) });
      if (max == null || value > max) max = value;
    }
  }

  // Keep the few largest, deduped — the card only ever shows a headline figure.
  const seen = new Set();
  const top = list
    .sort((a, b) => b.value - a.value)
    .filter((r) => (seen.has(r.value) ? false : (seen.add(r.value), true)))
    .slice(0, 5);
  return { list: top, max };
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AUDIENCE = [
  [/新戶|新開戶|首次開立|首次開戶|新客戶/, '新戶'],
  [/靜止戶|久未交易|未曾交易/, '靜止戶'],
  [/既有客戶|現有客戶|全體客戶|不限身分|所有客戶/, '既有客戶'],
  [/證券戶|加開|複委託戶/, '證券戶加開'],
];

export function pickAudience(flat) {
  return AUDIENCE.filter(([re]) => re.test(flat)).map(([, name]) => name);
}

const PRODUCTS = [
  [/股票期貨|股期|個股期/, '股票期貨'],
  [/ETF\s*期貨/i, 'ETF期貨'],
  [/微型|微台|微那斯達克|MNQ|MES|MYM/i, '微型商品'],
  [/選擇權|option/i, '選擇權'],
  [/CME|芝商所|那斯達克|S&P|黃金|原油|海外期貨|國外期貨|外期/i, '國外期貨'],
  [/台指期|大台|小台|國內期貨/, '國內期貨'],
  [/CFD|差價契約|槓桿交易|槓桿保證金/i, 'CFD／槓桿'],
];

export function pickProducts(flat, title) {
  const hay = `${title} ${flat}`;
  return PRODUCTS.filter(([re]) => re.test(hay)).map(([, name]) => name);
}
