// Refreshes data/schemes.json (AMFI) and data/sebi.json (SEBI RSS).
// Runs in GitHub Actions on a schedule. Node 18+ (uses global fetch). No dependencies.
// If a source is unreachable or returns junk, the previous file is kept and the run still succeeds,
// so the live site never goes blank.

import { readFile, writeFile } from 'node:fs/promises';
import { parseNavAll, parseSebiRss } from './lib.mjs';

const ROOT = new URL('..', import.meta.url);
const path = (p) => new URL(p, ROOT);

const AMFI_URLS = [
  'https://www.amfiindia.com/spages/NAVAll.txt',
  'https://portal.amfiindia.com/spages/NAVAll.txt',
];
const SEBI_URLS = [
  'https://www.sebi.gov.in/sebirss.xml',
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
const rss = await getText(SEBI_URLS, 'SEBI');
if (rss) {
  const items = parseSebiRss(rss);
  if (items.length) {
    const prev = await readJson('data/sebi.json', { items: [] });
    // Keep a rolling history of MF-related items so older circulars don't vanish from the feed.
    const seen = new Set();
    const merged = [...items.filter((i) => i.mf), ...(prev.items || [])]
      .filter((i) => { const k = i.link || i.title; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
      .slice(0, 40);
    await writeJson('data/sebi.json', { updatedAt: now, source: 'SEBI RSS', sourceUrl: SEBI_URLS[0], items: merged });
    console.log(`SEBI: ${items.length} items in feed, ${merged.length} MF-related kept`);
  } else {
    problems.push('SEBI feed had no items; kept previous data');
  }
} else {
  problems.push('SEBI unreachable; kept previous data');
}

const status = await readJson('data/status.json', {});
await writeJson('data/status.json', { ...status, lastRun: now, problems });
if (problems.length) console.warn('Problems:\n  ' + problems.join('\n  '));
