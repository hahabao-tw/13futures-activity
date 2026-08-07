import iconv from 'iconv-lite';
import { UA } from './util.mjs';

const TIMEOUT = 25000;

/**
 * Plain GET with retry. Returns decoded text, honouring the charset declared in
 * the response headers or the meta tag — a few brokers still serve Big5.
 */
export async function getText(url, { retries = 2, timeout = TIMEOUT } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      const buffer = Buffer.from(await res.arrayBuffer());
      return { text: decode(buffer, contentType), finalUrl: res.url, contentType };
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function getJson(url, options = {}) {
  const { text } = await getText(url, options);
  return JSON.parse(text);
}

/** HEAD-ish probe used to decide whether a candidate is a PDF/image rather than a page. */
export async function contentTypeOf(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    return res.headers.get('content-type') ?? '';
  } catch {
    return '';
  }
}

function decode(buffer, contentType) {
  const declared = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  const sniffed = /charset=["']?([\w-]+)/i
    .exec(buffer.subarray(0, 2048).toString('latin1'))?.[1]
    ?.toLowerCase();
  const charset = declared ?? sniffed ?? 'utf-8';
  if (/big5|cp950|ms950/.test(charset)) return iconv.decode(buffer, 'big5');
  if (/gb2312|gbk/.test(charset)) return iconv.decode(buffer, 'gbk');
  return buffer.toString('utf8');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
