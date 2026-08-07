// Debug one URL end-to-end: what the landing reader saw, how it scored, and what
// the rules pulled out. `node scripts/inspect.mjs <url> [--text]`
import { closeBrowser } from './lib/browser.mjs';
import { classify } from './lib/classify.mjs';
import { extract, pickPeriod, pickRewards } from './lib/extract.mjs';
import { readLanding } from './lib/landing.mjs';
import { clean, cleanBlock } from './lib/util.mjs';

const url = process.argv[2];
const showText = process.argv.includes('--text');

let page = await readLanding(url);
// Mirror the pipeline: confirmed campaigns with unread fields get a browser re-read.
if (page.kind === 'page' && page.via === 'http') {
  const probe = extract(page, { url, pic: '', label: '' });
  if (probe.missing.length) {
    const rendered = await readLanding(url, { mode: 'browser' });
    if (rendered.kind === 'page' && rendered.text.length > page.text.length) page = rendered;
  }
}
console.log(`via=${page.via}  kind=${page.kind}  textLen=${page.text.length}`);
console.log(`title: ${page.title}`);
console.log(`h1   : ${(page.h1 ?? []).join(' / ')}`);

const candidate = { url, pic: '', label: '', area: 'carousel', hints: { onEventUrl: true, heroBanner: true, labelHints: true } };
const verdict = classify(candidate, page);
console.log('verdict:', JSON.stringify(verdict));

if (page.kind === 'page') {
  const fields = extract(page, candidate);
  console.log('fields :', JSON.stringify(fields, null, 2));
  const flat = clean(page.text);
  const block = cleanBlock(page.text);
  const windows = [...block.matchAll(/(?:活動|報名|抽獎|競賽|任務|贈獎)(?:期間|時間|日期|起訖)[\s\S]{0,90}/g)]
    .map((m) => m[0].replace(/\s+/g, ' '))
    .slice(0, 5);
  console.log('期間附近文字:', JSON.stringify(windows, null, 2));
  console.log('period:', JSON.stringify(pickPeriod(block, flat)));
  console.log('rewards:', JSON.stringify(pickRewards(flat).list));
}

if (showText) console.log('\n----- TEXT -----\n' + page.text.slice(0, 4000));
await closeBrowser();
