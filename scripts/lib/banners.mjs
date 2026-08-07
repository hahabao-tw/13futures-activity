import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { shrinkImage } from './browser.mjs';
import { UA } from './util.mjs';

/**
 * Banner images are copied into the site rather than hotlinked.
 *
 * Half of them refuse to load cross-origin — 元大, 永豐, 凱基 and 群益 all serve
 * their banner files only to requests that look like they came from their own
 * site. Since the picture is the fallback for every campaign whose terms live
 * inside it, a broken image is not a cosmetic problem here; it is the whole card.
 *
 * Requests carry the campaign page as Referer, which is what the broker's own
 * pages send and what their hotlink checks are looking for.
 */
const DIR = new URL('../../site/banners/', import.meta.url);
/**
 * Two separate budgets. Brokers ship 1920px banners of 2–4 MB, so the download
 * ceiling only needs to catch something pathological; what actually goes into the
 * repo is bounded by the downscale below.
 */
const MAX_DOWNLOAD = 8_000_000;
const MAX_STORED = 400_000;
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export async function cacheBanners(campaigns) {
  await mkdir(DIR, { recursive: true });
  const kept = new Set();

  for (const campaign of campaigns) {
    if (!campaign.pic || campaign.pic.startsWith('banners/')) {
      if (campaign.pic?.startsWith('banners/')) kept.add(campaign.pic.slice('banners/'.length));
      continue;
    }
    const saved = await download(campaign.pic, campaign.url, campaign.id);
    if (saved) {
      campaign.picSource = campaign.pic;
      campaign.pic = `banners/${saved}`;
      kept.add(saved);
    } else {
      // Leave the original URL: it may still load in a browser that sends a
      // referer we cannot fake from Node, and a broken <img> is removed client-side.
      campaign.picSource = campaign.pic;
    }
  }

  for (const file of await readdir(DIR).catch(() => [])) {
    if (!kept.has(file)) await unlink(new URL(file, DIR)).catch(() => {});
  }
  return kept.size;
}

async function download(src, referer, id) {
  try {
    const res = await fetch(src, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: referer,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) return null;
    const original = Buffer.from(await res.arrayBuffer());
    if (!original.length || original.length > MAX_DOWNLOAD) return null;

    // GIFs would lose their animation, and small files gain nothing.
    let buffer = original;
    let outExt = ext;
    if (ext !== 'gif' && original.length > 60_000) {
      const smaller = await shrinkImage(original, type).catch(() => null);
      if (smaller && smaller.length < original.length) {
        buffer = smaller;
        outExt = 'jpg';
      }
    }
    if (buffer.length > MAX_STORED) return null;

    const name = `${id}.${outExt}`;
    await writeFile(new URL(name, DIR), buffer);
    return name;
  } catch {
    return null;
  }
}
