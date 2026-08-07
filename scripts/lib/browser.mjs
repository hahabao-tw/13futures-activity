import { chromium } from 'playwright';
import { UA, absolute, clean } from './util.mjs';

let browser;
let context;

export async function openBrowser() {
  if (browser) return;
  browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    userAgent: UA,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });
  // Fonts and media add seconds per page and none of it affects the DOM we read.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'font' || type === 'media') return route.abort();
    return route.continue();
  });
}

export async function closeBrowser() {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  browser = undefined;
  context = undefined;
}

/**
 * Every page interaction runs under a hard deadline.
 *
 * Playwright's own timeouts cover navigation and actions but *not* page.evaluate,
 * and that is the gap that matters here: the harvester and the landing reader both
 * do their real work inside evaluate. One of 統一's pages stalled there and the
 * whole crawl sat on it for 23 minutes until the CI job was killed — 12 brokers
 * lost to one page.
 *
 * Closing the page is what actually unblocks a stuck evaluate, so the timeout has
 * to be here, wrapped around the body, rather than inside each caller.
 */
const PAGE_BUDGET_MS = 75_000;

async function withPage(fn, budget = PAGE_BUDGET_MS) {
  await openBrowser();
  const page = await context.newPage();
  let timer;
  try {
    return await Promise.race([
      fn(page),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`頁面處理超過 ${budget / 1000}s`)), budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await page.close().catch(() => {});
  }
}

/**
 * Loads a page and returns every banner-ish link on it.
 *
 * The whole approach rests on one observation: brokers put the campaign wording
 * inside the banner image, but the destination stays in the DOM. So the harvester
 * never needs to read pixels — it needs to find the link that a picture points at,
 * across the four ways these sites wire that up:
 *
 *   1. <a href> wrapping an <img>                    (凱基, 統一, 國泰, 華南…)
 *   2. an element with a CSS background-image whose
 *      <a> lives inside it                           (元大)
 *   3. <a href="#" onclick="BLog(id,'<url>',…)">     (國票)
 *   4. no link at all in the DOM — banner data comes
 *      from an API                                   (康和, handled per broker)
 */
export async function harvestPage(url, { wait = 3500, scroll = true } = {}) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (scroll) {
      await page
        .evaluate(async () => {
          for (let y = 0; y < 4000; y += 800) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 150));
          }
          window.scrollTo(0, 0);
        })
        .catch(() => {});
    }
    await page.waitForTimeout(wait);

    const raw = await page.evaluate(() => {
      const out = [];
      const pictureOf = (el) => {
        const img = el.matches?.('img') ? el : el.querySelector?.('img');
        if (img) {
          const src = img.currentSrc || img.src || img.dataset?.src || img.dataset?.original || '';
          if (src && !src.startsWith('data:')) return { pic: src, alt: img.alt || img.title || '' };
          // Lazy-loaded banners keep a base64 placeholder in src; the real file is
          // usually parked on a data-* attribute.
          for (const key of ['src', 'original', 'lazy', 'lazySrc', 'bg']) {
            const v = img.dataset?.[key];
            if (v && !v.startsWith('data:')) return { pic: v, alt: img.alt || img.title || '' };
          }
          return { pic: '', alt: img.alt || img.title || '' };
        }
        return null;
      };
      const bgOf = (el) => {
        for (const node of [el, ...el.querySelectorAll('*')].slice(0, 40)) {
          const b = getComputedStyle(node).backgroundImage;
          if (b && b !== 'none' && b.includes('url(') && !b.includes('gradient')) {
            return b.match(/url\(["']?([^"')]+)/)?.[1] ?? '';
          }
        }
        return '';
      };

      // (1) and (3): every anchor, with whatever picture and onclick it carries.
      for (const a of document.querySelectorAll('a')) {
        const found = pictureOf(a);
        const bg = found?.pic ? '' : bgOf(a);
        const onclick = a.getAttribute('onclick') ?? '';
        const rawHref = a.getAttribute('href') ?? '';
        if (!found && !bg && !onclick) continue;
        out.push({
          href: a.href && !a.href.endsWith('#') ? a.href : '',
          rawHref,
          onclick,
          text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          title: a.getAttribute('title') ?? '',
          pic: found?.pic ?? bg,
          alt: found?.alt ?? '',
          area: areaOf(a),
        });
      }

      // (2): background image on a wrapper, anchor nested inside it.
      for (const el of document.querySelectorAll('[style*="background-image"], .banner_img')) {
        const bg = bgOf(el);
        if (!bg) continue;
        const inner = el.querySelector('a[href]');
        if (!inner) continue;
        out.push({
          href: inner.href,
          rawHref: inner.getAttribute('href') ?? '',
          onclick: inner.getAttribute('onclick') ?? '',
          text: (inner.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          title: inner.getAttribute('title') ?? '',
          pic: bg,
          alt: '',
          area: areaOf(el),
        });
      }

      // Plain text links, for brokers who list campaigns as a bulleted 活動專區.
      for (const a of document.querySelectorAll('a[href]')) {
        const text = (a.innerText || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 60) continue;
        out.push({
          href: a.href,
          rawHref: a.getAttribute('href') ?? '',
          onclick: '',
          text: text.slice(0, 120),
          title: a.getAttribute('title') ?? '',
          pic: '',
          alt: '',
          area: areaOf(a),
          textOnly: true,
        });
      }

      return { pageUrl: location.href, pageTitle: document.title, rows: out };

      // A crude "is this in the hero area" flag: carousels are the highest-signal
      // place a campaign can sit, and it is worth scoring them higher.
      function areaOf(el) {
        for (let n = el, i = 0; n && i < 8; n = n.parentElement, i++) {
          const c = `${n.id ?? ''} ${typeof n.className === 'string' ? n.className : ''}`;
          if (/swiper|slick|carousel|bxslider|banner|kv|hero|caroufredsel|owl/i.test(c)) {
            return 'carousel';
          }
          if (/footer/i.test(c)) return 'footer';
        }
        return 'body';
      }
    });

    return raw.rows
      .map((row) => shape(row, raw.pageUrl))
      .filter((row) => row && row.url);
  });
}

/**
 * Downscales an image using the browser that is already running, so the project
 * needs no native image dependency. Banners come off these sites at 1920px and
 * several hundred KB each; the cards render them about 400px wide, and the repo
 * has to carry every one of them for as long as the campaign runs.
 */
export async function shrinkImage(buffer, mime, maxWidth = 760) {
  const source = `data:${mime};base64,${buffer.toString('base64')}`;
  return withPage(async (page) => {
    await page.setContent('<body style="margin:0">');
    const out = await page.evaluate(
      async ([src, width]) => {
        const img = new Image();
        img.decoding = 'sync';
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('decode failed'));
          img.src = src;
        });
        if (img.naturalWidth <= width) return null;
        const scale = width / img.naturalWidth;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.82);
      },
      [source, maxWidth]
    );
    if (!out) return null;
    return Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
  });
}

/**
 * Grabs the readable text of a landing page, for classification and extraction.
 * Retries once: a render that times out under load comes back looking exactly like
 * an image-only campaign page, and downstream that difference decides whether the
 * link is kept.
 */
export async function readPage(url, attempt = 0) {
  try {
    return await renderOnce(url);
  } catch (err) {
    if (attempt >= 1) throw err;
    return readPage(url, attempt + 1);
  }
}

async function renderOnce(url) {
  return withPage(async (page) => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page
      .evaluate(async () => {
        for (let y = 0; y < 12000; y += 1000) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
      })
      .catch(() => {});
    await page.waitForTimeout(1200);
    // Campaign rules are routinely folded behind a 展開看更多 toggle; the terms we
    // need (活動期間, 獎項) live inside. Clicking every plausible toggle is cheaper
    // than guessing which one matters.
    await page
      .evaluate(() => {
        const wanted = /展開|看更多|more|詳細|注意事項|活動辦法|活動規則/i;
        const clickable = document.querySelectorAll('button, a, [class*="more"], [class*="expand"], summary');
        let n = 0;
        for (const el of clickable) {
          if (n > 25) break;
          const t = (el.innerText || el.textContent || '').trim();
          if (t && t.length < 20 && wanted.test(t)) {
            try {
              el.click();
              n++;
            } catch {}
          }
        }
        for (const d of document.querySelectorAll('details')) d.open = true;
      })
      .catch(() => {});
    await page.waitForTimeout(800);
    return page.evaluate(() => ({
      url: location.href,
      title: document.title,
      h1: [...document.querySelectorAll('h1,h2')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 6),
      text: document.body?.innerText ?? '',
      status: 200,
      images: [...document.querySelectorAll('img')]
        .map((i) => i.currentSrc || i.src || '')
        .filter((s) => s && !s.startsWith('data:'))
        .slice(0, 40),
    })).then((data) => ({ ...data, status: response?.status() ?? 0 }));
  });
}

function shape(row, base) {
  let href = row.href;
  // (3) 國票 stashes the destination as an argument to an onclick handler.
  if (!href && row.onclick) {
    const found = row.onclick.match(/['"]((?:https?:\/\/|\/)[^'"]{4,})['"]/);
    if (found) href = found[1];
  }
  if (!href && /^(?!javascript:|#)/.test(row.rawHref)) href = row.rawHref;
  const url = absolute(href, base);
  if (!url) return null;
  return {
    url,
    pic: absolute(row.pic, base) ?? '',
    label: clean(row.alt || row.title || row.text),
    area: row.area,
    textOnly: Boolean(row.textOnly),
  };
}
