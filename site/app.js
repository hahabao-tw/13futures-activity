const [data, status] = await Promise.all([
  fetch('data.json', { cache: 'no-cache' }).then((r) => r.json()),
  // Written on every run, unlike data.json. Lets the page say when it was last
  // checked, not just when the contents last moved.
  fetch('status.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null),
]);
const sources = status?.sources ?? data.sources ?? [];
const TODAY = new Date().toISOString().slice(0, 10);

/** One hue per broker, reused by the card border and the timeline bar. */
const HUES = [4, 22, 42, 62, 96, 132, 166, 190, 208, 232, 258, 286, 320];
const hueOf = new Map(data.brokers.map((b, i) => [b.id, HUES[i % HUES.length]]));
// Timeline bars carry white text, so the fill has to stay dark enough for it at
// every hue — yellows go muddy long before blues do.
const colour = (id, l = 40, s = 64) => `hsl(${hueOf.get(id) ?? 200} ${s}% ${l}%)`;
const nameOf = new Map(data.brokers.map((b) => [b.id, b.name]));

const state = { view: 'timeline', status: 'live', audience: 'all', sort: 'end' };
const main = document.getElementById('main');
const root = document.documentElement;

/* ---------- appearance ---------- */

const SIZE_NAMES = ['最小', '小', '中', '大', '最大'];

function paintTheme() {
  document.getElementById('theme').textContent = root.dataset.theme === 'dark' ? '☀' : '☾';
}

function paintSize() {
  const step = Number(root.dataset.size ?? 2);
  document.getElementById('size-now').textContent = SIZE_NAMES[step];
  for (const b of document.querySelectorAll('[data-size-step]')) {
    const next = step + Number(b.dataset.sizeStep);
    b.disabled = next < 0 || next > 4;
  }
}

document.getElementById('theme').addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark';
  root.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('theme', root.dataset.theme);
  paintTheme();
});

for (const button of document.querySelectorAll('[data-size-step]')) {
  button.addEventListener('click', () => {
    const next = Number(root.dataset.size ?? 2) + Number(button.dataset.sizeStep);
    if (next < 0 || next > 4) return;
    root.dataset.size = String(next);
    localStorage.setItem('size', String(next));
    paintSize();
  });
}

paintTheme();
paintSize();

/* ---------- controls ---------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  state.view = tab.dataset.view;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t === tab);
  render();
});

document.getElementById('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const group = chip.closest('.filter-group');
  state[group.dataset.filter] = chip.dataset.value;
  for (const c of group.querySelectorAll('.chip')) c.classList.toggle('is-on', c === chip);
  render();
});

renderCounts();
render();

function visible() {
  return data.campaigns
    .filter((c) => {
      if (state.status === 'live') return c.status !== 'ended';
      if (state.status === 'ended') return c.status === 'ended';
      return true;
    })
    .filter((c) => state.audience === 'all' || (c.audience ?? []).includes(state.audience))
    .sort(sorter);
}

function sorter(a, b) {
  if (state.sort === 'value') return (b.maxValue ?? -1) - (a.maxValue ?? -1);
  if (state.sort === 'broker') {
    return (
      data.brokers.findIndex((x) => x.id === a.broker) - data.brokers.findIndex((x) => x.id === b.broker) ||
      (a.period?.end ?? '9999').localeCompare(b.period?.end ?? '9999')
    );
  }
  // Ending soonest first, but campaigns with no known period sink rather than
  // sorting as if they ended in the year 9999 at the top.
  const rank = { active: 0, upcoming: 1, unknown: 2, ended: 3 };
  return (
    rank[a.status] - rank[b.status] ||
    (a.period?.end ?? '9999-12-31').localeCompare(b.period?.end ?? '9999-12-31')
  );
}

function render() {
  main.innerHTML = '';
  main.append(state.view === 'timeline' ? timeline(visible()) : cards(visible()));
}

function renderCounts() {
  const n = (f) => data.campaigns.filter(f).length;
  document.getElementById('counts').innerHTML = [
    ['live', n((c) => c.status === 'active'), '進行中'],
    ['', n((c) => c.status === 'upcoming'), '即將開始'],
    ['', n((c) => c.status === 'unknown'), '期間未知'],
    ['', n((c) => c.status === 'ended'), '已結束'],
    ['', data.brokers.length, '收錄期貨商'],
  ]
    .map(([cls, value, label]) => `<div class="count ${cls}"><b>${value}</b><span>${label}</span></div>`)
    .join('');

  const stamp = (iso) =>
    new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

  const foot = document.getElementById('updated');
  foot.textContent =
    `資料更新：${stamp(data.generatedAt)}（台北時間）` +
    (status?.checkedAt ? `　上次檢查：${stamp(status.checkedAt)}` : '') +
    `　來源：${sources.filter((s) => s.ok).length}/${sources.length} 家抓取成功`;

  // The board looking unchanged for a month is normal; the crawler having stopped
  // a month ago looks exactly the same from the outside. Only the check time can
  // tell those apart, so say so when it goes stale. Threshold allows for a
  // weekend: the crawl only runs on weekdays.
  const hours = status?.checkedAt ? (Date.now() - new Date(status.checkedAt).getTime()) / 3600000 : null;
  if (hours != null && hours > 96) {
    const warn = el('p', 'stale', `⚠ 已經 ${Math.floor(hours / 24)} 天沒有成功抓取，看板內容可能過期。`);
    foot.parentNode.insertBefore(warn, foot);
  }
}

/* ---------- timeline ---------- */

function timeline(list) {
  const wrap = el('div', 'tl');
  const dated = list.filter((c) => c.period?.start || c.period?.end);
  const undated = list.filter((c) => !c.period?.start && !c.period?.end);

  if (!dated.length && !undated.length) {
    wrap.append(el('div', 'empty', '目前沒有符合條件的活動。'));
    return wrap;
  }

  if (dated.length) {
    const starts = dated.map((c) => c.period.start ?? c.period.end);
    const ends = dated.map((c) => c.period.end ?? c.period.start);
    const from = monthStart(min([...starts, TODAY]));
    const to = monthEnd(max([...ends, TODAY]));
    const months = monthsBetween(from, to);
    const span = days(from, to) || 1;
    const pos = (d) => (days(from, clamp(d, from, to)) / span) * 100;

    const scroll = el('div', 'tl-scroll');
    const grid = el('div', 'tl-grid');

    const head = el('div', 'tl-head');
    head.append(el('div', 'tl-name', '活動'));
    const monthRow = el('div', 'tl-months');
    for (const m of months) monthRow.append(el('div', 'tl-month', m.label));
    head.append(monthRow);
    grid.append(head);

    const body = el('div', 'tl-body');
    for (const c of dated) {
      const row = el('div', 'tl-row');
      const name = el('div', 'tl-name');
      name.innerHTML = `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.title)}">${esc(
        c.title
      )}</a><small>${esc(nameOf.get(c.broker) ?? c.broker)}</small>`;
      row.append(name);

      const track = el('div', 'tl-track');
      const guides = el('div', 'tl-guides');
      for (const _ of months) guides.append(el('div', 'tl-guide'));
      track.append(guides);

      const start = c.period.start ?? c.period.end;
      const end = c.period.end ?? c.period.start;
      const bar = el('div', `tl-bar ${c.status}`);
      bar.style.left = `${pos(start)}%`;
      bar.style.width = `${Math.max(pos(end) - pos(start), 1.2)}%`;
      bar.style.setProperty('--hue', hueOf.get(c.broker) ?? 200);
      bar.title = `${c.period.start ?? '？'} ～ ${c.period.end ?? '？'}`;
      bar.textContent = c.maxValue ? `最高 ${money(c.maxValue)}` : '';
      track.append(bar);
      row.append(track);
      body.append(row);
    }

    const todayLine = el('div', 'tl-today');
    todayLine.style.left = `calc(15rem + (100% - 15rem) * ${pos(TODAY) / 100})`;
    body.append(todayLine);
    grid.append(body);
    scroll.append(grid);
    wrap.append(scroll);
  }

  if (undated.length) {
    wrap.append(
      el(
        'div',
        'empty',
        `另有 ${undated.length} 檔未標示活動期間（活動辦法多以圖片呈現，無法自動判讀），請見「卡片」。`
      )
    );
  }
  return wrap;
}

/* ---------- cards ---------- */

/**
 * Always grouped by broker, and the brokers always run in 筆劃 order — the same
 * order the 公告看板 uses, so the two boards read the same way. `data.brokers`
 * arrives already sorted, so following that array is the whole implementation.
 *
 * The sort control still applies, but within each broker's block rather than
 * across the page: someone comparing campaigns wants one broker's offers side by
 * side, not the highest reward from thirteen different companies interleaved.
 */
function cards(list) {
  const frag = document.createDocumentFragment();

  for (const broker of data.brokers) {
    const mine = list.filter((c) => c.broker === broker.id);
    const block = el('div', 'broker-block');
    const head = el('div', 'broker-head');
    const dot = el('span', 'dot');
    dot.style.background = colour(broker.id);
    head.append(dot, el('h2', '', broker.name), el('span', 'n', mine.length ? `${mine.length} 檔` : '—'));
    const source = sources.find((s) => s.id === broker.id);
    if (source && !source.ok) head.append(el('span', 'n', `⚠ 抓取失敗：${source.error ?? ''}`));
    block.append(head);

    if (!mine.length) {
      block.append(el('div', 'empty', '目前在官網上找不到符合條件的活動。'));
    } else {
      const grid = el('div', 'grid');
      for (const c of mine) grid.append(card(c));
      block.append(grid);
    }
    frag.append(block);
  }
  return frag;
}

const STATUS_TEXT = { active: '進行中', upcoming: '即將開始', ended: '已結束', unknown: '期間未知' };

function card(c, withBroker = false) {
  const box = el('article', 'card');

  if (c.pic) {
    const img = el('img', 'card-pic');
    img.src = c.pic;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }

  const body = el('div', 'card-body');
  const h3 = el('h3');
  h3.innerHTML = `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>`;
  body.append(h3);

  const meta = el('div', 'meta');
  if (withBroker) {
    const who = el('span', 'tag broker', nameOf.get(c.broker) ?? c.broker);
    // Only the hue crosses over; the stylesheet decides how light it should be,
    // because that answer differs between the two themes.
    who.style.setProperty('--hue', hueOf.get(c.broker) ?? 200);
    meta.append(who);
  }
  meta.append(el('span', `tag status-${c.status}`, STATUS_TEXT[c.status] ?? c.status));
  if (c.maxValue) meta.append(el('span', 'tag value', `最高 ${money(c.maxValue)}`));
  for (const a of c.audience ?? []) meta.append(el('span', 'tag', a));
  for (const p of (c.products ?? []).slice(0, 3)) meta.append(el('span', 'tag', p));
  if (c.kind === 'course') meta.append(el('span', 'tag', '課程講座'));
  body.append(meta);

  // One line, not two. The broker's own wording is the more useful of the pair —
  // it is what the campaign page says — so the normalised ISO range only appears
  // when there is no original wording to show.
  body.append(el('div', 'period', periodText(c)));

  if (c.suspect) {
    body.append(
      el(
        'div',
        'note warn',
        '這檔仍掛在該期貨商首頁輪播，但讀到的期間已經過去 —— 可能是活動已改版而期間讀錯，請以原頁面為準。'
      )
    );
  }
  if ((c.missing ?? []).length) {
    const what = c.missing.map((m) => (m === 'period' ? '活動期間' : '獎勵金額')).join('、');
    body.append(
      el(
        'div',
        'note',
        c.imageOnly
          ? `無法辨識${what}：活動辦法以圖片呈現，請點入原頁面判讀。`
          : `無法辨識${what}：原頁面未以文字寫明，請點入原頁面判讀。`
      )
    );
  }
  if (c.ambiguousPeriod) {
    body.append(el('div', 'note', '原頁面出現多組日期，此處採用「活動期間」標示的那一組。'));
  }
  if (c.note) body.append(el('div', 'note', c.note));

  const foot = el('div', 'card-foot');
  foot.append(
    el('span', '', [c.manual ? '人工補登' : c.source === 'feed' ? '活動訊息' : 'banner', c.confidence === 'low' ? '低信心' : '']
      .filter(Boolean)
      .join('・'))
  );
  const link = el('a', '', '前往活動頁 →');
  link.href = c.url;
  link.target = '_blank';
  link.rel = 'noopener';
  foot.append(link);
  body.append(foot);

  box.append(body);
  return box;
}

const HAS_LABEL = /^(活動|報名|抽獎|競賽|任務|贈獎)(期間|時間|日期|起訖)/;

/**
 * The stored `raw` is whatever the campaign page actually wrote, and some pages
 * state the dates without ever labelling them ("2026/7/1 至 2026/9/30"). On a card
 * a bare date range is ambiguous, so the label is added here rather than in the
 * extractor — data.json keeps the page's own wording.
 */
function periodText(c) {
  const raw = c.period?.raw;
  if (raw) return HAS_LABEL.test(raw) ? raw : `活動期間 ${raw}`;
  if (c.period?.start || c.period?.end) {
    return `活動期間 ${c.period.start ?? '？'} ～ ${c.period.end ?? '？'}`;
  }
  return '活動期間未標示';
}

/* ---------- helpers ---------- */

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function money(n) {
  return n >= 10000 ? `NT$${(n / 10000).toLocaleString('zh-TW')}萬` : `NT$${n.toLocaleString('zh-TW')}`;
}

function min(xs) {
  return xs.reduce((a, b) => (a < b ? a : b));
}

function max(xs) {
  return xs.reduce((a, b) => (a > b ? a : b));
}

function clamp(d, lo, hi) {
  return d < lo ? lo : d > hi ? hi : d;
}

function monthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

function monthEnd(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function days(from, to) {
  return (Date.parse(to) - Date.parse(from)) / 86400000;
}

function monthsBetween(from, to) {
  const out = [];
  const cursor = new Date(from + 'T00:00:00Z');
  const last = new Date(to + 'T00:00:00Z');
  while (cursor <= last) {
    out.push({
      label: `${cursor.getUTCMonth() + 1}月` + (cursor.getUTCMonth() === 0 ? ` ${cursor.getUTCFullYear()}` : ''),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
