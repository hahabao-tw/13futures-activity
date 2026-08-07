import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { canonicalUrl } from './util.mjs';

const FILE = new URL('../../seeds.yml', import.meta.url);

/**
 * The manual channel. It does two jobs:
 *
 *   `add`      — campaigns the crawler cannot reach: Facebook-only posts, links
 *                behind a login, anything a broker never put on its own site.
 *                Give it a url and it goes through the same classify/extract path
 *                as a harvested link; give it fields too and they win.
 *   `override` — a campaign the crawler did find, but whose period or reward the
 *                rules read wrong (or not at all). Keyed on url.
 *   `block`    — a url the classifier keeps letting through that is not a campaign.
 *
 * This is what stands in for a model: when the rules cannot read a page, a human
 * writes the two fields that matter instead of the rules growing another branch.
 */
export async function loadSeeds() {
  let raw;
  try {
    raw = parse(await readFile(FILE, 'utf8')) ?? {};
  } catch {
    return { add: [], overrides: new Map(), blocked: new Set() };
  }
  const add = (raw.add ?? []).filter((s) => s?.url && s?.broker);
  const overrides = new Map(
    (raw.override ?? []).filter((s) => s?.url).map((s) => [canonicalUrl(s.url), s])
  );
  const blocked = new Set((raw.block ?? []).map((u) => canonicalUrl(typeof u === 'string' ? u : u.url)));
  return { add, overrides, blocked };
}

/** Seed fields beat extracted ones, field by field, so a partial fix stays partial. */
export function applyOverride(campaign, seed) {
  if (!seed) return campaign;
  const out = { ...campaign };
  if (seed.title) out.title = seed.title;
  if (seed.start || seed.end) {
    out.period = {
      start: seed.start ?? out.period?.start ?? null,
      end: seed.end ?? out.period?.end ?? null,
      raw: seed.periodText ?? out.period?.raw ?? null,
      source: 'manual',
    };
  }
  if (seed.maxValue != null) out.maxValue = Number(seed.maxValue);
  if (seed.audience) out.audience = [].concat(seed.audience);
  if (seed.products) out.products = [].concat(seed.products);
  if (seed.kind) out.kind = seed.kind;
  if (seed.note) out.note = seed.note;
  if (seed.pic) out.pic = seed.pic;
  out.manual = true;
  out.confidence = 'high';
  out.missing = [
    !out.period?.start && !out.period?.end ? 'period' : null,
    out.maxValue == null ? 'reward' : null,
  ].filter(Boolean);
  return out;
}
