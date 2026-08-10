import { access, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
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
 *
 * Everything is re-encoded to WebP at 640px. Brokers ship 1920px banners of 2-4 MB
 * each; the cards render them about 400px wide, so the original is between five and
 * fifty times larger than anything the page can show.
 */
const DIR = new URL('../../site/banners/', import.meta.url);
const MAX_DOWNLOAD = 8_000_000;
const MAX_STORED = 300_000;
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
    // A campaign carried over from a previous run already points at a local file.
    // Trust that only if the file is actually still there — a lost or pruned image
    // should be re-fetched from the source URL, not left as a broken card.
    if (campaign.pic?.startsWith('banners/')) {
      const name = campaign.pic.slice('banners/'.length);
      if (await exists(name)) {
        kept.add(name);
        continue;
      }
      campaign.pic = campaign.picSource ?? '';
    }
    if (!campaign.pic) continue;

    const source = campaign.pic;
    const saved = await download(source, campaign.url, campaign.id);
    campaign.picSource = source;
    if (saved) {
      campaign.pic = `banners/${saved}`;
      kept.add(saved);
    }
    // Otherwise the original URL stays in place: some of them do load in a browser
    // that sends a referer we cannot fake, and a broken <img> is removed client-side.
  }

  for (const file of await readdir(DIR).catch(() => [])) {
    if (!kept.has(file)) await unlink(new URL(file, DIR)).catch(() => {});
  }
  return kept.size;
}

async function exists(name) {
  try {
    await access(new URL(name, DIR));
    return true;
  } catch {
    return false;
  }
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

    // GIFs would lose their animation; everything else is re-encoded.
    let buffer = original;
    let outExt = ext;
    if (ext !== 'gif') {
      const smaller = await shrinkImage(original, type).catch(() => null);
      if (smaller && smaller.buffer.length < original.length) {
        buffer = smaller.buffer;
        outExt = smaller.ext;
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
