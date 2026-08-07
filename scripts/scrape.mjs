import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { BROKERS } from './sources/index.mjs';
import {
  KEEP_ENDED_DAYS,
  MAX_CANDIDATES_PER_BROKER,
  MAX_PER_BROKER,
  MISSES_BEFORE_ENDED,
} from './config.mjs';
import { cacheBanners } from './lib/banners.mjs';
import { closeBrowser, harvestPage, openBrowser } from './lib/browser.mjs';
import { classify, confirm, preScreen } from './lib/classify.mjs';
import { extract } from './lib/extract.mjs';
import { readLanding } from './lib/landing.mjs';
import { mapPool } from './lib/pool.mjs';
import { applyOverride, loadSeeds } from './lib/seeds.mjs';
import { TODAY, canonicalUrl, hash, statusOf } from './lib/util.mjs';

const OUT_FILE = new URL('../site/data.json', import.meta.url);
const STATUS_ORDER = { active: 0, upcoming: 1, unknown: 2, ended: 3 };
const CHROME_IMAGE =
  /(logo|icon|btn|button|arrow|nav|menu|footer|header|bg[-_.]|sprite|avatar|qrcode|line|fb|share)/i;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('--verbose');

const today = TODAY();
const previous = await readPrevious();
const seeds = await loadSeeds();
const targets = only.length ? BROKERS.filter((b) => only.includes(b.id)) : BROKERS;

await openBrowser();
const report = [];
const campaigns = [];

for (const broker of targets) {
  const started = Date.now();
  const result = { id: broker.id, name: broker.name, ok: true, error: null, found: 0, checked: 0 };
  try {
    const candidates = await collect(broker);
    result.checked = candidates.length;
    if (verbose) {
      for (const c of candidates) {
        console.log(`    ? 候選 ${c.url}\n        label=${c.label} area=${c.area} pic=${c.pic ? 'y' : 'n'} hints=${JSON.stringify(c.hints)}`);
      }
    }

    const judged = await mapPool(candidates, 4, async (candidate) => {
      let page = await readLanding(candidate.url);
      if (page.kind !== 'page') return null;

      // Brokers hide campaign links behind their own shorteners (cathaysec.tw/…,
      // kgif.tw/…), so what a link is really pointing at is only known after the
      // redirect. Screen the destination as well as the link.
      if (page.url !== candidate.url && !preScreen({ ...candidate, url: page.url }, broker)) {
        if (verbose) console.log(`    · 跳過 ${candidate.url} → ${page.url}  (轉址後不符)`);
        return null;
      }

      let verdict = classify(candidate, page);

      // A client-rendered landing page can serve enough og: text to look ordinary
      // over HTTP while keeping its terms behind JavaScript. Re-read in a browser
      // when the page sits on an event URL and the cheap read found nothing.
      if (!verdict.ok && candidate.hints?.onEventUrl && page.via === 'http' && page.text.length < 2000) {
        page = await readLanding(candidate.url, { mode: 'browser' });
        if (page.kind === 'page') verdict = classify(candidate, page);
      }
      if (verbose && !verdict.ok) {
        console.log(`    · 跳過 ${candidate.url}  (${verdict.reason})`);
      }
      if (!verdict.ok) return null;

      let fields = extract(page, candidate);
      if (fields.missing.length && page.via === 'http') {
        const rendered = await readLanding(candidate.url, { mode: 'browser' });
        if (rendered.kind === 'page' && rendered.text.length > page.text.length) {
          const better = extract(rendered, candidate);
          if (better.missing.length < fields.missing.length) {
            page = rendered;
            fields = better;
          }
        }
      }

      verdict = confirm(verdict, fields, candidate, page);
      if (!verdict.ok) {
        if (verbose) console.log(`    · 跳過 ${candidate.url}  (${verdict.reason})`);
        return null;
      }
      return { candidate, page, verdict, fields };
    });

    for (const row of judged) {
      if (!row || row.error) continue;
      campaigns.push(toCampaign(broker, row));
    }
    result.found = campaigns.filter((c) => c.broker === broker.id).length;
    console.log(
      `✓ ${broker.name.padEnd(10)} 候選 ${String(result.checked).padStart(3)} → 活動 ${String(
        result.found
      ).padStart(2)}\t${Date.now() - started}ms`
    );
  } catch (err) {
    result.ok = false;
    result.error = String(err?.message ?? err).slice(0, 200);
    console.log(`✗ ${broker.name}\t${result.error}`);
  }
  report.push(result);
}

// Seeded campaigns go through the same reading and scoring as harvested ones, so a
// Facebook-only campaign ends up with the same shape as everything else.
for (const seed of seeds.add) {
  const broker = BROKERS.find((b) => b.id === seed.broker);
  if (!broker) continue;
  if (only.length && !only.includes(broker.id)) continue;
  try {
    const candidate = { url: canonicalUrl(seed.url), pic: seed.pic ?? '', label: seed.title ?? '', area: 'seed', hints: { onEventUrl: true, labelHints: true } };
    const page = await readLanding(candidate.url);
    const verdict = page.kind === 'page' ? classify(candidate, page) : { ok: false };
    const fields = page.kind === 'page' ? extract(page, candidate) : blankFields(seed);
    campaigns.push(
      applyOverride(
        toCampaign(broker, {
          candidate,
          page,
          verdict: verdict.ok ? verdict : { ok: true, score: 0, confidence: 'low', kind: seed.kind ?? 'promo' },
          fields,
        }),
        seed
      )
    );
  } catch (err) {
    console.log(`✗ seed ${seed.url}\t${err.message}`);
  }
}

const merged = merge(campaigns);
// Still inside the browser session: the banner cache downscales through it.
const cached = await cacheBanners(merged);
await closeBrowser();
console.log(`\nbanner 圖 ${cached} 張已存入 site/banners/`);

const payload = {
  generatedAt: new Date().toISOString(),
  brokers: BROKERS.map(({ id, name }) => ({ id, name })),
  sources: report,
  campaigns: merged,
};

const signature = signatureOf(merged);
if (signature === signatureOf(previous.list)) {
  console.log('\n活動內容與上次相同，data.json 不變更。');
} else {
  await mkdir(new URL('../site/', import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload) + '\n', 'utf8');
  console.log('\n偵測到異動，已更新 data.json。');
}

summarise(merged);

// ---------------------------------------------------------------------------

async function collect(broker) {
  const pages = [broker.home, ...(broker.extraPages ?? [])];
  let raw = [];
  for (const page of pages) {
    raw = raw.concat(await harvestPage(page));
  }
  if (broker.extra) raw = raw.concat(await broker.extra());

  const seeded = seeds.add
    .filter((s) => s.broker === broker.id)
    .map((s) => canonicalUrl(s.url));

  const screened = raw
    .map((row) => ({ ...row, url: canonicalUrl(row.url) }))
    .filter((row) => !seeds.blocked.has(row.url))
    .filter((row) => !seeded.includes(row.url))
    .map((row) => preScreen(row, broker))
    .filter(Boolean);

  // The same campaign is routinely reachable two ways — a homepage banner and a
  // row in the 活動訊息 feed. Merging rather than picking the first keeps whichever
  // source knew the picture and whichever knew the publish date.
  const byUrl = new Map();
  for (const row of screened) {
    const before = byUrl.get(row.url);
    if (!before) {
      byUrl.set(row.url, row);
      continue;
    }
    byUrl.set(row.url, {
      ...before,
      pic: before.pic || row.pic,
      label: before.label || row.label,
      date: before.date ?? row.date,
      area: before.area === 'carousel' || row.area === 'carousel' ? 'carousel' : before.area,
      hints: {
        onEventUrl: before.hints.onEventUrl || row.hints.onEventUrl,
        labelHints: before.hints.labelHints || row.hints.labelHints,
        heroBanner: before.hints.heroBanner || row.hints.heroBanner,
      },
    });
  }
  return [...byUrl.values()].slice(0, MAX_CANDIDATES_PER_BROKER);
}

function toCampaign(broker, { candidate, page, verdict, fields }) {
  const url = canonicalUrl(page.url ?? candidate.url);
  // When the rules came up empty, the card falls back to showing a picture — so
  // it matters that the picture is the campaign's own artwork, not a nav icon.
  const pic = candidate.pic || heroImage(page) || '';
  const base = {
    id: hash(broker.id, url),
    broker: broker.id,
    brokerName: broker.name,
    title: fields.title,
    url,
    pic,
    // 統一 and several others publish the whole campaign as a stack of JPEGs with
    // only the boilerplate as text. Nothing can be read off those without vision,
    // so the card says so and links straight through.
    imageOnly: page.kind === 'page' && page.text.length < 1500 && (page.images?.length ?? 0) > 2,
    kind: verdict.kind ?? 'info',
    // Whether the broker is currently pushing this on their front page. Used to
    // catch the case that a period was read wrong: see `suspect` in merge().
    promoted: candidate.area === 'carousel',
    confidence: fields.period?.ambiguous && verdict.confidence === 'high' ? 'medium' : verdict.confidence ?? 'low',
    ambiguousPeriod: Boolean(fields.period?.ambiguous),
    score: verdict.score ?? 0,
    period: fields.period,
    audience: fields.audience,
    products: fields.products,
    maxValue: fields.maxValue,
    rewards: fields.rewards,
    missing: fields.missing,
    source: candidate.area === 'seed' ? 'manual' : candidate.area === 'feed' ? 'feed' : 'banner',
    manual: false,
  };
  return applyOverride(base, seeds.overrides.get(url));
}

function heroImage(page) {
  for (const src of page.images ?? []) {
    if (CHROME_IMAGE.test(src)) continue;
    if (/\.svg(\?|$)/i.test(src)) continue;
    return src;
  }
  return '';
}

function blankFields(seed) {
  return {
    title: seed.title ?? '(未命名活動)',
    period: { start: seed.start ?? null, end: seed.end ?? null, raw: null, source: 'manual' },
    audience: [],
    products: [],
    rewards: [],
    maxValue: seed.maxValue ?? null,
    missing: [],
  };
}

/**
 * Folds this run into the previous one. Campaigns carry history the crawl cannot
 * see: when they were first noticed, and how many runs in a row they have been
 * missing — which is the only way to tell that an undated campaign has finished.
 */
function merge(current) {
  const now = new Date().toISOString();
  const seen = new Map(current.map((c) => [c.id, c]));
  const out = [];

  for (const campaign of current) {
    const before = previous.byId.get(campaign.id);
    const status = statusOf(campaign.period);
    out.push({
      ...campaign,
      firstSeen: before?.firstSeen ?? now,
      lastSeen: now,
      misses: 0,
      status,
      // A contradiction worth surfacing rather than resolving: the broker is still
      // running this on their front-page carousel, but the period we read says it
      // is over. Either they forgot to pull the banner, or the period was read off
      // the wrong line — which is exactly how 華南's refreshed 賞金盛典 was buried
      // as 已結束 while its new season was the first slide on their homepage.
      suspect: campaign.promoted && status === 'ended',
    });
  }

  const crawled = new Set(targets.map((b) => b.id));
  for (const before of previous.list) {
    if (seen.has(before.id)) continue;
    // Blocking a url in seeds.yml should take it off the board now, not after it
    // has aged out over the next couple of runs.
    if (seeds.blocked.has(canonicalUrl(before.url))) continue;
    // A broker that failed this run must not have its campaigns aged out.
    const brokerFailed = report.find((r) => r.id === before.broker && !r.ok);
    if (!crawled.has(before.broker) || brokerFailed) {
      out.push(before);
      continue;
    }
    const misses = (before.misses ?? 0) + 1;
    const gone = misses >= MISSES_BEFORE_ENDED;
    const status = before.period?.end
      ? statusOf(before.period)
      : gone
        ? 'ended'
        : before.status ?? 'unknown';
    if (status === 'ended' && daysSince(before.lastSeen) > KEEP_ENDED_DAYS) continue;
    out.push({ ...before, misses, status, offline: gone });
  }

  const perBroker = new Map();
  return out
    .sort(sortCampaigns)
    .filter((c) => {
      const n = (perBroker.get(c.broker) ?? 0) + 1;
      perBroker.set(c.broker, n);
      return n <= MAX_PER_BROKER;
    });
}

function sortCampaigns(a, b) {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (b.maxValue ?? -1) - (a.maxValue ?? -1) ||
    (a.period?.end ?? '9999').localeCompare(b.period?.end ?? '9999') ||
    a.id.localeCompare(b.id)
  );
}

function daysSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function signatureOf(list) {
  return JSON.stringify(
    list
      // pic is in here because the banner cache rewrites it to a local path on the
      // first successful download; without it that rewrite never reaches data.json.
      .map((c) => [c.id, c.title, c.status, c.period?.start, c.period?.end, c.maxValue, c.pic])
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

async function readPrevious() {
  try {
    const json = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    const list = json.campaigns ?? [];
    return { list, byId: new Map(list.map((c) => [c.id, c])) };
  } catch {
    return { list: [], byId: new Map() };
  }
}

function summarise(list) {
  const active = list.filter((c) => c.status === 'active');
  const incomplete = list.filter((c) => c.status !== 'ended' && c.missing?.length);
  console.log(
    `\n共 ${list.length} 檔（進行中 ${active.length}、即將開始 ${
      list.filter((c) => c.status === 'upcoming').length
    }、已結束 ${list.filter((c) => c.status === 'ended').length}、未知期間 ${
      list.filter((c) => c.status === 'unknown').length
    }）`
  );
  if (incomplete.length) {
    console.log(`無法辨識 ${incomplete.length} 檔：`);
    for (const c of incomplete.slice(0, 15)) {
      console.log(`  · [${c.brokerName}] ${c.title}  讀不到 ${c.missing.join('/')}\n      ${c.url}`);
    }
  }

  // Loud on purpose. This is the class of failure that looks like success:
  // the campaign is on the board, just with the wrong dates.
  const suspect = list.filter((c) => c.suspect);
  if (suspect.length) {
    console.log(`\n⚠ 仍掛在首頁輪播、卻判定已結束的 ${suspect.length} 檔（請確認期間是否讀錯）：`);
    for (const c of suspect) {
      console.log(`  · [${c.brokerName}] ${c.title}  ${c.period?.start}~${c.period?.end}\n      ${c.url}`);
    }
  }

  const ambiguous = list.filter((c) => c.ambiguousPeriod && c.status !== 'ended');
  if (ambiguous.length) console.log(`\n頁面同時出現多組期間、已擇一採用：${ambiguous.length} 檔`);

  const failed = report.filter((r) => !r.ok);
  if (failed.length) console.log(`抓取失敗：${failed.map((f) => f.name).join('、')}`);
}
