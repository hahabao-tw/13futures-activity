import { getJson } from '../lib/http.mjs';
import { absolute, clean } from '../lib/util.mjs';

/**
 * 康和's carousel renders <a> tags with no href — the click handler is wired from
 * the same JSON the images come from. Reading that JSON is both cheaper and richer
 * than clicking through the carousel, because it also carries BannerName, which is
 * the only piece of human-written text describing each banner.
 */
const API =
  'https://www.concordfutures.com.tw/ConcordsAPI/FC_API/api/F_ConcordFutures/F_GetActiveBannerUpload';
const BASE = 'https://www.concordfutures.com.tw/';
const PICTURE_BASE = 'https://www.concordfutures.com.tw/WebSiteUpload/ActiveBannerUpload/';

export default async function concordBanners() {
  const out = [];
  for (const kind of ['advertise', 'propaganda']) {
    let payload;
    try {
      payload = await getJson(`${API}?ActiveKind=${kind}`);
    } catch {
      continue;
    }
    for (const row of payload?.content ?? []) {
      if (row.InUse !== '1') continue;
      const url = absolute(row.Url, BASE);
      if (!url) continue;
      out.push({
        url,
        pic: row.PicPath ? `${PICTURE_BASE}${row.BannerID}/${encodeURIComponent(row.PicPath)}` : '',
        label: clean(row.BannerName),
        area: kind === 'advertise' ? 'carousel' : 'body',
      });
    }
  }
  return out;
}
