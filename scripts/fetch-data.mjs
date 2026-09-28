// Refreshes data/schemes.json (AMFI) and data/sebi.json (SEBI RSS).
// Runs in GitHub Actions on a schedule. Node 18+ (uses global fetch). No dependencies.
// If a source is unreachable or returns junk, the previous file is kept and the run still succeeds,
// so the live site never goes blank.

import { readFile, writeFile } from 'node:fs/promises';
import { parseNavAll, parseSebiRss, parseSebiListing } from './lib.mjs';

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
const UA = 'Mozilla/5.0 (compatible; FundFit-data-refresh/2.0; +https://github.com/babubl)';

async function getText(urls, label) {
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
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

// ---------- AMFI ----------
const navText = await getText(AMFI_URLS, 'AMFI');
if (navText) {
  const parsed = parseNavAll(navText, categories);
  if (parsed.schemes.length >= 300 && parsed.amcs.length >= 20) {
    await writeJson('data/schemes.json', {
      updatedAt: now,
      source: 'AMFI NAVAll.txt',
      sourceUrl: AMFI_URLS[0],
      navDate: parsed.navDate,
      amcs: parsed.amcs,
      schemes: parsed.schemes,
      unmapped: parsed.unmapped,
      labels: parsed.labels,
    });
    console.log(`AMFI: ${parsed.amcs.length} AMCs, ${parsed.schemes.length} schemes, NAV date ${parsed.navDate}`);
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
if (rss) fresh.push(...parseSebiRss(rss));
for (const l of SEBI_LISTINGS) {
  const html = await getText([l.url], 'SEBI ' + l.type + 's');
  if (html) {
    const rows = parseSebiListing(html, l.type);
    console.log(`SEBI ${l.type}s: ${rows.length} rows, ${rows.filter((r) => r.mf).length} MF-related`);
    fresh.push(...rows);
  }
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

const status = await readJson('data/status.json', {});
await writeJson('data/status.json', { ...status, lastRun: now, problems });
if (problems.length) console.warn('Problems:\n  ' + problems.join('\n  '));
