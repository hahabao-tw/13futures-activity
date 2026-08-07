import { createHash } from 'node:crypto';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Several brokers republish text lifted from 期交所 PDFs, which encodes some
 * glyphs as CJK compatibility ideographs (金 as U+F90A). Those look identical on
 * screen but fail every string match, so normalise to NFKC before anything else
 * touches the text. Full-width digits and tildes collapse here too, which the
 * date-range rules depend on.
 */
export function clean(text) {
  return decodeEntities(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * For text that gets shown rather than matched. NFKC is right for matching but
 * wrong for display: it rewrites 全形 punctuation into ASCII, so a title comes out
 * as "登記享專人開戶陪跑,最高領 $1700 交易應援金!" instead of the 「，」「！」the
 * broker actually wrote. NFC leaves that alone.
 */
export function cleanDisplay(text) {
  return decodeEntities(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same normalisation, but keeps line breaks so "活動期間" windows stay local. */
export function cleanBlock(text) {
  return decodeEntities(text ?? '')
    .normalize('NFKC')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function absolute(href, base) {
  if (!href) return null;
  const raw = href.trim();
  if (!raw || /^(javascript:|#|mailto:|tel:|data:)/i.test(raw)) return null;
  try {
    // A few brokers emit "//" mid-path (康和 writes .com.tw///WebSiteUpload/…).
    const url = new URL(raw, base);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Campaign URLs are the identity here, but brokers decorate them with tracking
 * parameters that change between runs (utm_*, EmpNo, empno, SourceId). Stripping
 * those keeps a campaign from being rediscovered as "new" on every crawl.
 */
export function canonicalUrl(href) {
  try {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid|empno|sourceid|source|from|ref)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    let out = url.href;
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    return href;
  }
}

export function hash(...parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Normalises one date token into YYYY-MM-DD. Handles ROC years and 8/1 shorthand. */
export function toISODate(raw, { year } = {}) {
  const s = clean(raw);
  let m;
  if ((m = s.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/))) {
    return pad(m[1], m[2], m[3]);
  }
  if ((m = s.match(/\b(1\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/))) {
    return pad(String(Number(m[1]) + 1911), m[2], m[3]);
  }
  if ((m = s.match(/\b(20\d{2})(\d{2})(\d{2})\b/))) return pad(m[1], m[2], m[3]);
  if (year && (m = s.match(/\b(\d{1,2})\s*[-/.月]\s*(\d{1,2})\b/))) {
    return pad(String(year), m[1], m[2]);
  }
  return null;
}

function pad(y, mo, d) {
  const month = Number(mo);
  const day = Number(d);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const TODAY = () => new Date().toISOString().slice(0, 10);

/** Campaign lifecycle, derived from the period rather than stored. */
export function statusOf(period, today = TODAY()) {
  if (!period?.start && !period?.end) return 'unknown';
  // A date lifted from the URL is a publication date, not a period — it can retire
  // a campaign whose page has sat there since 2022, but it must never promote one
  // to 進行中 on that evidence alone.
  if (period.source === 'url') {
    return period.start && monthsBetween(period.start, today) > 9 ? 'ended' : 'unknown';
  }
  if (period.end && period.end < today) return 'ended';
  if (period.start && period.start > today) return 'upcoming';
  return 'active';
}

function monthsBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((it) => {
    const key = keyOf(it);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fileNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}
