// Refreshes data/schemes.json (AMFI) and data/sebi.json (SEBI RSS).
// Runs in GitHub Actions on a schedule. Node 18+ (uses global fetch). No dependencies.
// If a source is unreachable or returns junk, the previous file is kept and the run still succeeds,
// so the live site never goes blank.

import { readFile, writeFile } from 'node:fs/promises';
import { parseNavAll, parseSebiRss, parseSebiListing, parseNavHistory, addReturns, parseTer, addTer, norm } from './lib.mjs';

const ROOT = new URL('..', import.meta.url);
const path = (p) => new URL(p, ROOT);

const AMFI_URLS = [
  'https://www.amfiindia.com/spages/NAVAll.txt',
  'https://portal.amfiindia.com/spages/NAVAll.txt',
];
const SEBI_RSS = ['https://www.sebi.gov.in/sebirss.xml'];
const SEBI_LISTINGS = [
  { type: 'Circular', url: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=7&smid=0' },
];
const HISTORY_URL = (d) => `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${d}`;
const TER_AMCS_URL = 'https://www.amfiindia.com/api/populate-mf';
const TER_URL = (id, month) => `https://www.amfiindia.com/api/populate-te-rdata-revised?MF_ID=${id}&Month=${month}&strCat=-1&strType=1&page=1&pageSize=20000`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parseAmfiDate = (s) => { const m = String(s).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/); return m ? new Date(Date.UTC(+m[3], MON.indexOf(m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()), +m[1])) : null; };
const fmtAmfiDate = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (compatible; FundFit-data-refresh/2.0; +https://github.com/babubl)';

async function getText(urls, label, attempts = 3) {
  for (const url of urls) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        console.log(`${label}: ${url} OK (${text.length} bytes)`);
        return text;
      } catch (e) {
        console.warn(`${label}: ${url} attempt ${attempt} failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  }
  return null;
}

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fallback; }
}

async function writeJson(p, obj) {
  await writeFile(path(p), JSON.stringify(obj) + '\n');
}

const now = new Date().toISOString();
const { categories } = await readJson('data/categories.json', { categories: [] });
let problems = [];
const sources = {};

// ---------- AMFI ----------
const navText = await getText(AMFI_URLS, 'AMFI');
if (navText) {
  const parsed = parseNavAll(navText, categories);
  if (parsed.schemes.length >= 300 && parsed.amcs.length >= 20) {
    // ----- Returns from AMFI NAV history (1, 3 and 5 years before today's NAV date) -----
    const base = parseAmfiDate(parsed.navDate);
    const current = parseNavHistory(navText).navs;
    const histories = [];
    if (base) {
      for (const years of [1, 3, 5]) {
        let got = null;
        for (let back = 0; back < 7 && !got; back++) {
          const d = new Date(base); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() - back);
          const txt = await getText([HISTORY_URL(fmtAmfiDate(d))], `AMFI history ${years}y ${fmtAmfiDate(d)}`, 1);
          const h = txt ? parseNavHistory(txt) : null;
          if (h && h.navs.size > 300) got = { years, navs: h.navs, date: fmtAmfiDate(d) };
        }
        if (got) histories.push(got); else problems.push(`AMFI NAV history for ${years}y ago unavailable`);
      }
      addReturns(parsed.schemes, current, histories);
    }
    const withReturns = parsed.schemes.filter((x) => x.r).length;
    sources.returns = { dates: histories.map((h) => h.date), schemes: withReturns };
    console.log(`Returns: ${withReturns} schemes, history dates ${histories.map((h) => h.date).join(', ')}`);

    // ----- Expense ratios (TER) from AMFI, one call per fund house -----
    let terMatched = 0;
    try {
      const listTxt = await getText([TER_AMCS_URL], 'AMFI TER fund houses', 2);
      const list = listTxt ? JSON.parse(listTxt) : [];
      const byName = new Map(parsed.amcs.map((a, i) => [norm(a.name.replace(/mutual fund/i, '')), i]));
      const terByAmc = new Map();
      const months = base ? [0, 1].map((k) => { const d = new Date(base); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; }) : [];
      for (const m of list) {
        const i = byName.get(norm(String(m.mfName || '').replace(/mutual fund/i, '')));
        if (i === undefined) continue;
        for (const month of months) {
          await sleep(700);
          const t = await getText([TER_URL(m.mfId, month)], `TER ${m.mfName} ${month}`, 2);
          let rows = [];
          try { rows = t ? JSON.parse(t).data || [] : []; } catch { rows = []; }
          if (rows.length) { terByAmc.set(i, parseTer(rows)); break; }
        }
      }
      terMatched = addTer(parsed.schemes, parsed.amcs, terByAmc);
      sources.ter = { amcs: terByAmc.size, matched: terMatched };
      console.log(`TER: ${terByAmc.size} fund houses, ${terMatched} schemes matched`);
    } catch (e) {
      problems.push('TER fetch failed: ' + e.message);
    }

    await writeJson('data/schemes.json', {
      updatedAt: now,
      source: 'AMFI NAVAll.txt',
      sourceUrl: AMFI_URLS[0],
      navDate: parsed.navDate,
      returnsAsOf: histories.map((h) => ({ years: h.years, date: h.date })),
      amcs: parsed.amcs,
      schemes: parsed.schemes,
      unmapped: parsed.unmapped,
      labels: parsed.labels,
    });
    console.log(`AMFI: ${parsed.amcs.length} AMCs, ${parsed.schemes.length} schemes, NAV date ${parsed.navDate}`);
    sources.amfi = { ok: true, amcs: parsed.amcs.length, schemes: parsed.schemes.length, navDate: parsed.navDate, unmapped: parsed.unmapped.length };
    if (parsed.unmapped.length) {
      console.log('AMFI labels with no category match (update "amfi" aliases in data/categories.json):');
      for (const u of parsed.unmapped) console.log(`  - ${u.label} (${u.count})`);
    }
  } else {
    problems.push(`AMFI parse looked wrong (${parsed.amcs.length} AMCs, ${parsed.schemes.length} schemes); kept previous data`);
  }
} else {
  problems.push('AMFI unreachable; kept previous data');
}

// ---------- SEBI ----------
// Two sources: the RSS feed (latest ~30 items of all kinds, mostly enforcement orders) and the
// circulars listing (last 25). Only mutual-fund-related items are kept,
// merged with the previous history so older ones don't drop off.
const fresh = [];
const rss = await getText(SEBI_RSS, 'SEBI RSS');
if (rss) {
  const items = parseSebiRss(rss);
  fresh.push(...items);
  sources.sebiRss = { ok: true, items: items.length, mf: items.filter((i) => i.mf).length };
} else sources.sebiRss = { ok: false };
for (const l of SEBI_LISTINGS) {
  const html = await getText([l.url], 'SEBI ' + l.type + 's');
  if (html) {
    const rows = parseSebiListing(html, l.type);
    console.log(`SEBI ${l.type}s: ${rows.length} rows, ${rows.filter((r) => r.mf).length} MF-related`);
    fresh.push(...rows);
    sources['sebi' + l.type] = { ok: true, bytes: html.length, rows: rows.length, mf: rows.filter((r) => r.mf).length, debug: rows.length ? undefined : { hasLinks: html.includes('legal/circulars'), ajax: [...new Set(html.match(/[\w\/.-]*ajax[\w\/.-]*/gi) || [])].slice(0, 10), tableSnippet: (html.match(/<table[\s\S]{0,1200}/i) || [''])[0] } };
  } else { sources['sebi' + l.type] = { ok: false }; problems.push('SEBI ' + l.type + 's page unreachable'); }
}
if (fresh.length) {
  const prev = await readJson('data/sebi.json', { items: [] });
  const seen = new Set();
  const merged = [...fresh.filter((i) => i.mf), ...(prev.items || [])]
    .filter((i) => { const k = i.link || i.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 60);
  await writeJson('data/sebi.json', { updatedAt: now, sources: [...SEBI_RSS, ...SEBI_LISTINGS.map((l) => l.url)], items: merged });
  console.log(`SEBI: ${fresh.length} items fetched, ${merged.length} MF-related kept`);
} else {
  problems.push('SEBI unreachable; kept previous data');
}

await writeJson('data/status.json', { lastRun: now, problems, sources });
if (problems.length) console.warn('Problems:\n  ' + problems.join('\n  '));
