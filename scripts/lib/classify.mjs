import { clean, fileNameOf } from './util.mjs';

/**
 * Hosts and paths that are never a campaign, however campaign-shaped the banner
 * around them looked. Checked before anything is fetched.
 */
const DEAD_HOSTS =
  /(facebook|instagram|youtube|youtu\.be|line\.me|liff\.line|t\.me|twitter|x\.com|linkedin|goo\.gl|maps\.google|google\.com\/maps|104\.com|1111\.com|518\.com|teamviewer)/i;

const UTILITY_PATH =
  /(login|signin|logout|password|forgot|certificate|\bca\b|sitemap|privacy|copyright|disclaimer|accessibility|contact|faq|download\/|\.exe|\.dmg|\.apk|\.zip|robots\.txt)/i;

/**
 * Reject outright. These pages routinely carry campaign vocabulary — a 防詐騙 page
 * says 注意事項, an award press release says 活動 — so keyword scoring alone lets
 * them through. 凱基's 期貨鑽石獎 press release was the case that forced this list.
 */
const NEVER = [
  /反詐|防詐|anti[-_]?fraud|詐騙/i,
  /徵才|招募|人才|求職|職缺|recruit/i,
  /永續|ESG|公益|社會責任|公司治理|內控/i,
  /隱私權|著作權|免責聲明|網站導覽|資通安全|洗錢防制/i,
  /樂齡|公平待客|金融友善|無障礙/i,
];

/** Award coverage looks like a campaign banner but is news. */
const AWARD_NEWS = /(榮獲|獲獎|得獎肯定|奪下|蟬聯|勇奪|再獲獎|頒獎典禮|評鑑肯定)/;

/** Generic campaign URL shapes, on top of each broker's own patterns. */
const EVENT_URL =
  /(\/event|\/events|\/eventweb|\/activity|\/activities|\/campaign|\/promo|\/promotion|\/ftactivity|activity\.|campaign\.|events\.|event\.)/i;

/** Landing-page vocabulary. Weight reflects how rarely a non-campaign page uses it. */
const SIGNALS = [
  [/活動期間|活動時間|活動日期|活動起訖/, 4],
  [/活動辦法|活動說明|活動內容|活動規則|活動對象|活動資格|活動商品/, 3],
  [/得獎名單|中獎名單|抽獎|摸彩|加碼抽|月月抽|週週抽/, 3],
  [/本活動/, 3],
  [/贈品|獎項|獎勵|好禮|禮券|享樂券|即享券|回饋金|折抵金|抵用金|禮金/, 2],
  [/開戶禮|入金禮|交易金|新戶專屬|新戶限定|靜止戶/, 2],
  [/代扣繳|扣繳憑單|本公司保留.{0,8}(修改|變更|終止)/, 2],
  [/立即參加|我要參加|登記|報名|立即開戶/, 1],
  [/回饋|優惠|免費|加碼|送你|送您|最高可得|最高領/, 1],
];

/**
 * The line between "a campaign" and "a product page that talks about rewards".
 *
 * Brokers park permanent marketing pages on the same /eventweb/ and /event/ paths
 * they use for real campaigns — 統一's MultiCharts teaching site and 群益's CFD
 * platform page both score well on 優惠/回饋/免費 without being campaigns at all.
 * What they never carry is the language of a campaign that starts and ends: a
 * period, terms, a draw, a winners list. Requiring one of these is what separates
 * them, and it is a far better filter than a higher score threshold.
 */
const CORE =
  /(活動期間|活動時間|活動日期|活動起訖|活動辦法|活動對象|活動資格|活動規則|本活動|得獎名單|中獎名單|抽獎|開戶禮|入金禮)/;

/** A standalone winners list is the aftermath of a campaign, not one itself. */
const RESULTS_ONLY = /(得獎名單|中獎名單|公布名單)/;

const COURSE = /(課程|講座|研習|說明會|直播|教學影音|線上課|實體課|報名表)/;
const PROMO = /(抽獎|贈品|獎項|禮券|享樂券|即享券|回饋金|折抵|開戶禮|好禮|獎勵|加碼)/;

/**
 * Cheap pass over a harvested link: is this worth spending a page fetch on?
 * Returns null to drop it, or a candidate carrying the reasons it survived.
 */
export function preScreen(candidate, broker) {
  const { url, label = '', pic = '', area } = candidate;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;

  // Carousels link back to their own front page constantly (logo, "回首頁", the
  // slide with no destination). The broker's own home is never a campaign.
  const path = parsed.pathname.replace(/\/(index|default)\.(html?|do|aspx|jsp)$/i, '/');
  if (path === '/' || path === '' || sameAsHome(url, broker.home)) return null;
  if (DEAD_HOSTS.test(host)) return null;
  if (/taifex\.com\.tw|twse\.com\.tw|tpex\.org\.tw|sfi\.org\.tw|twsa\.org\.tw|gov\.tw/i.test(host)) {
    return null;
  }
  if (UTILITY_PATH.test(url)) return null;

  const haystack = `${label} ${fileNameOf(url)} ${fileNameOf(pic)} ${url}`;
  if (NEVER.some((re) => re.test(haystack))) return null;

  const onEventUrl = EVENT_URL.test(url) || (broker.eventPatterns ?? []).some((re) => re.test(url));
  const labelHints = /(活動|開戶禮|好禮|抽|贈|回饋|優惠|加碼|折抵|獎|禮券|競賽|爭霸|挑戰|募集|限定|享)/.test(
    haystack
  );
  const heroBanner = area === 'carousel' && Boolean(pic);

  if (!onEventUrl && !labelHints && !heroBanner) return null;
  // A bare text link needs a real reason; carousel position does not apply to it.
  if (candidate.textOnly && !onEventUrl && !labelHints) return null;

  return {
    ...candidate,
    hints: { onEventUrl, labelHints, heroBanner },
  };
}

/**
 * "The page really is just pictures" — not "we failed to read it". The difference
 * matters: a truncated HTTP read looks identical to an image-only campaign page by
 * length alone, and treating a failed read as an image-only campaign lets any link
 * on an event path through whenever the render happens to time out. Requiring a
 * completed browser render that found images makes the test mean what it says.
 */
function imageOnly(page) {
  return page?.via === 'browser' && (page.text?.length ?? 0) < 200 && (page.images?.length ?? 0) > 1;
}

function stale(date, months = 9) {
  if (!date) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return date < cutoff.toISOString().slice(0, 10);
}

function sameAsHome(url, home) {
  if (!home) return false;
  const strip = (u) =>
    u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/(index|default)\.(html?|do|aspx|jsp)$/i, '/').replace(/\/+$/, '');
  return strip(url) === strip(home);
}

/**
 * Full judgement, once the landing page has been read.
 *
 * Two independent kinds of evidence: structural (the URL sits on an event path)
 * and semantic (the page reads like campaign terms). Either can carry a candidate
 * on its own — image-only landing pages have no text at all, and a campaign parked
 * on a plain URL has no structure — but the confidence differs.
 */
export function classify(candidate, page) {
  const text = clean(page?.text ?? '');
  const title = clean(page?.title ?? '');
  const heading = clean((page?.h1 ?? []).join(' '));
  const body = `${title} ${heading} ${text}`;

  if (NEVER.some((re) => re.test(`${title} ${heading}`))) {
    return { ok: false, reason: '排除類別' };
  }

  let score = 0;
  const matched = [];
  for (const [re, weight] of SIGNALS) {
    if (re.test(body)) {
      score += weight;
      matched.push(re.source.split('|')[0]);
    }
  }

  // Award press releases: campaign words appear, but never 活動期間 with a range.
  if (AWARD_NEWS.test(`${title} ${heading}`) && !/活動期間|活動時間/.test(body)) {
    return { ok: false, reason: '得獎新聞稿' };
  }

  const { onEventUrl, heroBanner, labelHints } = candidate.hints ?? {};
  const core = CORE.test(body);

  if (RESULTS_ONLY.test(`${title} ${heading}`) && !/活動期間|活動辦法/.test(body)) {
    return { ok: false, reason: '得獎名單頁' };
  }

  let ok = false;
  let confidence = 'low';
  if (core && score >= 7) {
    ok = true;
    confidence = 'high';
  } else if (core && score >= 4) {
    ok = true;
    confidence = onEventUrl ? 'high' : 'medium';
  } else if (core && score >= 2 && onEventUrl) {
    ok = true;
    confidence = 'medium';
  } else if (imageOnly(page) && onEventUrl && (heroBanner || labelHints)) {
    // Nothing to read, but the link sits on an event path and was presented as a
    // campaign. Keep it and let the banner image speak on the site itself.
    ok = true;
    confidence = 'low';
  }

  if (!ok) {
    return { ok: false, reason: core ? `訊號不足 (score=${score})` : '無活動辦法字樣', score };
  }

  const kind = PROMO.test(body) ? 'promo' : COURSE.test(body) ? 'course' : 'info';
  return { ok: true, score, confidence, kind, matched, thin: imageOnly(page) };
}

/**
 * Campaign wording is often shared page furniture rather than the page's own
 * content — 統一's /eventweb/ pages all inherit the same 活動注意事項 footer, so
 * their MultiCharts tutorial scores as high as a real campaign. Scoring alone
 * cannot separate them, because the words really are on the page.
 *
 * What does separate them is that a campaign announces itself: it states a period,
 * or it is named like one (…禮 / …賽 / …回饋 / …季 / 加碼 / 好禮). A standing
 * product page does neither. This runs after extraction, when the period is known.
 */
const CAMPAIGN_NAME =
  /(活動|抽獎|加碼|回饋|優惠|好禮|贈|禮|獎|賞|賽|盃|季|戰|專案|限定|募集|享|送|折抵|開戶金|體驗金)/;

export function confirm(verdict, fields, candidate, page) {
  if (!verdict.ok) return verdict;

  const hasPeriod =
    fields.period?.source !== 'url' && Boolean(fields.period?.start || fields.period?.end);
  // The banner's own label counts only when the landing page has nothing to read.
  // Otherwise a generic nav icon labelled 活動查詢 vouches for the login page
  // behind it, and 大昌's 20220120活動 banner vouches for a 2022 page.
  const named =
    CAMPAIGN_NAME.test(`${fields.title ?? ''} ${(page?.h1 ?? []).join(' ')}`) ||
    (verdict.thin && CAMPAIGN_NAME.test(candidate?.label ?? ''));

  if (hasPeriod) return { ...verdict, confidence: verdict.confidence };

  // The page never states a period, and the only date available — from the URL or
  // the feed row that carried it — is months old. A campaign that old with nothing
  // to confirm it is running is over: 大昌 still links a 2022 banner, 台新's feed
  // still lists a 2025 campaign marked 已額滿.
  if (fields.period?.source === 'url' && stale(fields.period.start)) {
    return { ...verdict, ok: false, reason: '僅有舊發佈日期，未見活動期間' };
  }

  if (named) {
    // No period read, but it is named like a campaign. Usually an image-only
    // landing page; keep it and flag the missing field rather than guess.
    return { ...verdict, confidence: verdict.confidence === 'high' ? 'medium' : 'low' };
  }
  return { ...verdict, ok: false, reason: '無活動期間且名稱非活動' };
}
