import { getJson } from '../lib/http.mjs';
import { clean, toISODate } from '../lib/util.mjs';

/**
 * 台新 is the one broker whose hero banners are dead ends: the carousel inlines
 * each banner as a base64 image inside <a href="">, so nothing links anywhere.
 * Their 活動訊息 feed carries the same campaigns, so that becomes the source.
 *
 * The API is the one the 公告看板 already reverse-engineered: POST a 0-based page
 * index as a plain-text body, get {"newslist":[…]} back. `linktype` decides the
 * link shape — 0 内文頁, 1 附件, 2 外部連結.
 */
const BASE = 'https://www.tsfutures.com.tw';
const FEED = 'news-event';
const ROUTE = 'news-event';

/** The feed runs back to 2023; anything older cannot be a live campaign. */
const MONTHS = 15;

export default async function tsfuturesFeed() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS);
  const since = cutoff.toISOString().slice(0, 10);

  const { totalpage } = await getJson(`${BASE}/api/${FEED}-totalpage`);
  const out = [];
  for (let page = 0; page < Math.min(totalpage ?? 1, 3); page += 1) {
    const res = await fetch(`${BASE}/api/${FEED}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: String(page),
      signal: AbortSignal.timeout(20000),
    });
    const { newslist = [] } = await res.json();
    for (const row of newslist) {
      const url = linkFor(row);
      const date = toISODate(row.startdateStr);
      if (!url || (date && date < since)) continue;
      out.push({ url, pic: '', label: clean(row.title), area: 'feed', date });
    }
  }
  return out;
}

function linkFor(row) {
  // The row id is `bulletininfono`, and the detail routes take it as ?no=.
  const id = row.bulletininfono;
  if (String(row.linktype) === '2' && row.titlelink) return row.titlelink;
  if (!id) return null;
  if (String(row.linktype) === '1') return `${BASE}/${ROUTE}-file?no=${id}`;
  return `${BASE}/${ROUTE}-content?no=${id}`;
}
