import concordBanners from './concord.mjs';
import tsfuturesFeed from './tsfutures.mjs';

/**
 * One entry per 期貨商. `home` and `extraPages` are crawled by the generic banner
 * harvester; `eventPatterns` marks the URL shapes that broker parks campaigns on,
 * which is what lets a text-free landing page still be recognised. `extra` is for
 * the two sites whose banners carry no link in the DOM at all.
 *
 * Sorted by 筆劃 the same way the 公告看板 does it, so the two sites list the
 * brokers in the same order.
 */
export const BROKERS = [
  {
    id: 'dcnf',
    name: '大昌期貨',
    strokes: [3, 8],
    home: 'https://www.dcnf.com.tw/',
    eventPatterns: [/dcn\.com\.tw\/EventWeb\//i],
  },
  {
    id: 'yuanta',
    name: '元大期貨',
    strokes: [4, 3],
    home: 'https://www.yuantafutures.com.tw/',
    eventPatterns: [
      /yuantafutures\.com\.tw\/(20\d{2}|StockFutures)/i,
      /ltm\.yuantafutures\.com\.tw\/(custom|course)/i,
    ],
  },
  {
    id: 'tsfutures',
    name: '台新期貨',
    strokes: [5, 13],
    home: 'https://www.tsfutures.com.tw/',
    // Hero banners here are inlined base64 images inside <a href="">, so there is
    // no destination to harvest. Their 活動訊息 feed is the only way in.
    extra: tsfuturesFeed,
    eventPatterns: [/tsfutures\.com\.tw\/news-event/i],
  },
  {
    id: 'spf',
    name: '永豐期貨',
    strokes: [5, 18],
    home: 'https://www.spf.com.tw/',
    eventPatterns: [/spf\.com\.tw\/mktinfo\/Futures\//i],
  },
  {
    id: 'mega',
    name: '兆豐期貨',
    strokes: [6, 18],
    home: 'https://www.megafutures.com.tw/',
    eventPatterns: [/events\.emega\.com\.tw/i, /project\.emega\.com\.tw\/project/i],
  },
  {
    id: 'concord',
    name: '康和期貨',
    strokes: [11, 8],
    home: 'https://www.concordfutures.com.tw/ConcordFutures/',
    // Banner anchors have no href; the carousel is driven by an API.
    extra: concordBanners,
    eventPatterns: [/concordfutures\.com\.tw\/Promote\//i, /iqt\.concords\.com\.tw/i],
  },
  {
    id: 'cathay',
    name: '國泰期貨',
    strokes: [11, 10],
    // The bare domain redirects here; using the redirect target lets the
    // "never treat the front page as a campaign" check actually match.
    home: 'https://www.cathayfut.com.tw/cathayfut/',
    eventPatterns: [/cathayfut\.com\.tw\/event\//i, /cathaysec\.tw\//i],
  },
  {
    id: 'ibff',
    name: '國票期貨',
    strokes: [11, 11],
    home: 'https://www.ibff.com.tw/',
    eventPatterns: [/ibff\.com\.tw\/Activity\//i],
  },
  {
    id: 'pfcf',
    name: '統一期貨',
    strokes: [12, 1],
    home: 'https://www.pfcf.com.tw/',
    eventPatterns: [/pfcf\.com\.tw\/eventweb\//i],
  },
  {
    id: 'fubon',
    name: '富邦期貨',
    strokes: [12, 7],
    home: 'https://www.fubon.com/futures/home/',
    eventPatterns: [/fubon\.com\/futures\/campaign\//i],
  },
  {
    id: 'entrust',
    name: '華南期貨',
    strokes: [12, 9],
    home: 'https://ft.entrust.com.tw/entrustFutures/index.do',
    // 華南's 活動專區 (/entrustFutures/activity/index.do) sits behind a login and
    // redirects anonymous visitors away, so the banners are the only public route.
    eventPatterns: [/ft\.entrust\.com\.tw\/ftActivity\//i, /events\.entrust\.com\.tw/i],
  },
  {
    id: 'kgi',
    name: '凱基期貨',
    strokes: [12, 11],
    home: 'https://www.kgif.com.tw/zh-tw/',
    eventPatterns: [/event\.kgi\.com\.tw/i, /kgif\.tw\//i],
  },
  {
    id: 'capital',
    name: '群益期貨',
    strokes: [13, 10],
    home: 'https://www.capitalfutures.com.tw/zh-tw/',
    eventPatterns: [
      /activity\.capitalfutures\.com\.tw/i,
      /campaign\.capitalfutures\.com\.tw/i,
      /capitalfutures\.com\.tw\/zh-tw\/smartlanding/i,
    ],
  },
].sort((a, b) => a.strokes[0] - b.strokes[0] || a.strokes[1] - b.strokes[1]);

export const BROKER_BY_ID = new Map(BROKERS.map((b) => [b.id, b]));
