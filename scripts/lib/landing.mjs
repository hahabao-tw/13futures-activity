import * as cheerio from 'cheerio';
import { getText } from './http.mjs';
import { readPage } from './browser.mjs';
import { absolute, cleanBlock, cleanDisplay } from './util.mjs';

/**
 * Reads a campaign landing page as text.
 *
 * Plain HTTP first: it costs ~200ms against ~5s for a browser page, and it is
 * enough for the majority of these landing pages. Escalates to Chromium only when
 * the HTML comes back too thin to classify, which is the signature of a
 * client-rendered page (元大's campaign sites, 富邦's SPA).
 */
const THIN = 400;

/**
 * `mode: 'browser'` skips the HTTP attempt entirely. The pipeline uses it for the
 * second pass over pages that already classified as campaigns but whose rules came
 * up empty — a landing page that serves a rich og:description but renders its terms
 * client-side (event.kgi.com.tw) returns enough text to pass the length check and
 * still hides 活動期間. Paying for a browser render on confirmed campaigns only
 * keeps the crawl fast without losing those fields.
 */
export async function readLanding(url, { mode = 'auto' } = {}) {
  if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?)(\?|$)/i.test(url)) {
    return { url, title: '', h1: [], text: '', kind: 'file', via: 'skip' };
  }
  if (mode === 'browser') return renderLanding(url);

  let httpText = '';
  let httpTitle = '';
  let httpH1 = [];
  let httpImages = [];
  let finalUrl = url;
  try {
    const res = await getText(url, { retries: 1 });
    if (/pdf|image|octet-stream/i.test(res.contentType)) {
      return { url: res.finalUrl, title: '', h1: [], text: '', kind: 'file', via: 'http' };
    }
    finalUrl = res.finalUrl;
    const parsed = toText(res.text, res.finalUrl);
    httpText = parsed.text;
    httpTitle = parsed.title;
    httpH1 = parsed.h1;
    httpImages = parsed.images;
  } catch {
    httpText = '';
  }

  if (httpText.length >= THIN) {
    return {
      url: finalUrl,
      title: httpTitle,
      h1: httpH1,
      text: httpText,
      images: httpImages,
      kind: 'page',
      via: 'http',
    };
  }

  const rendered = await renderLanding(url);
  if (rendered.kind === 'page') return rendered;
  return {
    url: finalUrl,
    title: httpTitle,
    h1: httpH1,
    text: httpText,
    kind: httpText ? 'page' : 'error',
    via: 'http',
    error: rendered.error,
  };
}

async function renderLanding(url) {
  try {
    const rendered = await readPage(url);
    return {
      url: rendered.url,
      title: rendered.title,
      h1: rendered.h1,
      // Line breaks survive on purpose: the period rules read a window after
      // 活動期間, and these pages put the label and the range on separate lines.
      text: cleanBlock(rendered.text),
      images: rendered.images,
      kind: 'page',
      via: 'browser',
    };
  } catch (err) {
    return { url, title: '', h1: [], text: '', kind: 'error', via: 'browser', error: String(err.message ?? err).slice(0, 120) };
  }
}

function toText(html, base) {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg').remove();
  const title = cleanDisplay($('title').first().text());
  const h1 = $('h1, h2')
    .map((_, el) => cleanDisplay($(el).text()))
    .get()
    .filter(Boolean)
    .slice(0, 6);
  // Collected here as well as in the browser path: whether a landing page is
  // "all pictures, no words" is decided from these two numbers together.
  const images = $('img')
    .map((_, el) => absolute($(el).attr('src') ?? $(el).attr('data-src') ?? '', base))
    .get()
    .filter(Boolean)
    .slice(0, 40);
  // Block-level tags become newlines so the period window can stay local.
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, section, td, dt, dd').append('\n');
  const text = cleanBlock($('body').text());
  return { title, h1, text, images };
}
