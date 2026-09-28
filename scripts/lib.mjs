// Pure parsing helpers, shared by fetch-data.mjs and the tests. No dependencies.

export const norm = (s) =>
  String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

export const slug = (s) =>
  String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Build alias -> [categoryId] lookup from categories.json
export function buildAliasMap(categories) {
  const map = new Map();
  for (const c of categories) {
    for (const a of [c.name, c.was, ...(c.amfi || [])]) {
      if (!a) continue;
      const k = norm(a);
      if (!map.has(k)) map.set(k, []);
      if (!map.get(k).includes(c.id)) map.get(k).push(c.id);
    }
  }
  return map;
}

// Map an AMFI section label ("Debt Scheme - Low Duration Fund") to category ids.
export function mapLabel(group, sub, aliasMap) {
  const direct = aliasMap.get(norm(sub));
  const g = norm(group);
  if (direct) {
    // "Sectoral Fund" exists in both equity and debt; use the group to disambiguate.
    if (direct.length > 1 && g.includes('debt')) {
      const d = direct.filter((id) => id === 'sectoral-debt');
      if (d.length) return d;
    }
    if (g.includes('debt') && direct.includes('sectoral')) return ['sectoral-debt'];
    return direct;
  }
  const s = norm(sub), gs = g + s;
  if (LEGACY.has(s) && g === s) return []; // old generic labels like "Income" or "Growth"
  if (gs.includes('lifecycle')) return ['life-cycle'];
  if (g.includes('debt') && s.includes('sectoral')) return ['sectoral-debt'];
  if (gs.includes('fof') || gs.includes('fundoffund')) return ['fof'];
  if (gs.includes('etf') || gs.includes('exchangetraded') || gs.includes('index')) return ['index-etf'];
  if (s.includes('elss') || s.includes('taxsaver')) return ['elss'];
  if (s.includes('balancedadvantage') || s.includes('dynamicassetallocation')) return ['daaf'];
  return [];
}

// Index funds/ETFs and fund of funds hold very different things under one SEBI category.
// Tag each with what it actually tracks, so gold ETFs don't sit next to Nifty funds.
export function kindOf(cats, name, label) {
  if (!cats.includes('index-etf') && !cats.includes('fof')) return '';
  const n = String(name).toLowerCase(), l = String(label).toLowerCase();
  if (/gold/.test(n) || /gold/.test(l)) return 'gold';
  if (/silver/.test(n) || /silver/.test(l)) return 'silver';
  if (/overseas|abroad/.test(l) || /nasdaq|s&p 500|\bus\b|u\.s\.|global|international|world|hang seng|japan|china|greater china|taiwan|europe|asia|emerging market|msci|nyse|fang|developed market/.test(n)) return 'intl';
  if (/debt|income/.test(l) || /gilt|g-?sec|\bsdl\b|bond|crisil|t-?bill|liquid|money market|target maturity|\bibx\b|debt|psu.*(plus|debt)|corporate|treasury|overnight|1d rate|\bbharat bond/.test(n)) return 'debt';
  if (/hybrid|arbitrage/.test(l) || /hybrid|balanced|multi[\s-]?asset|arbitrage|equity savings|asset allocat/.test(n)) return 'hybrid';
  return 'equity';
}

// Many fund houses still file sectoral and thematic funds under one AMFI label.
// Decide which one each scheme is from its name: a named sector means sectoral, else thematic.
const SECTOR_RE = /bank|financial|fin serv|pharma|health|technology|\btech\b|\bit\b|digital|\bauto|fmcg|energy|power|metal|realty|oil|chemical|telecom/i;
export function refineCats(cats, name) {
  if (cats.length === 2 && cats.includes('sectoral') && cats.includes('thematic')) return [SECTOR_RE.test(name) ? 'sectoral' : 'thematic'];
  return cats;
}

// AMFI historical NAV file for one date: "Scheme Code;NAV Name;Plan;Option;...;Net Asset Value;Date"
export function parseNavHistory(text) {
  const out = new Map();
  let navCol = -1, date = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Scheme Code\s*;/i.test(line)) { navCol = line.split(';').map((x) => x.trim().toLowerCase()).findIndex((x) => /net asset value|^nav$/.test(x)); continue; }
    const f = line.split(';');
    if (f.length < 6 || !/^\d+$/.test(f[0].trim())) continue;
    // NAV and date are the last two columns; read from the end so names with ";" don't shift them.
    const nav = parseFloat(f[f.length - 2]);
    if (!isNaN(nav) && nav > 0) out.set(f[0].trim(), nav);
    if (!date) date = f[f.length - 1].trim();
  }
  return { date, navs: out, navCol };
}

// Annualised return between two NAVs over `years`, in % with one decimal. null if unknown.
export function cagr(now, then, years) {
  if (!(now > 0) || !(then > 0)) return null;
  const r = years <= 1 ? now / then - 1 : Math.pow(now / then, 1 / years) - 1;
  return Math.round(r * 1000) / 10;
}

// Attach returns: s.r = { R: [1y, 3y, 5y], D: [...] }, s.y = years of history seen (1, 3 or 5+).
export function addReturns(schemes, current, histories) {
  // current: Map code -> today's NAV; histories: [{ years, navs: Map }]
  for (const s of schemes) {
    for (const [plan, code] of [['R', s.rc], ['D', s.dc]]) {
      if (!code || !current.has(code)) continue;
      const vals = histories.map((h) => cagr(current.get(code), h.navs.get(code), h.years));
      if (vals.some((v) => v !== null)) { (s.r ||= {})[plan] = vals; }
      const seen = histories.filter((h) => h.navs.has(code)).map((h) => h.years);
      if (seen.length) s.y = Math.max(s.y || 0, ...seen);
    }
  }
}

// AMFI TER API rows -> Map normName -> { R, D, date } (latest date per scheme)
export function parseTer(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const k = norm(r.Scheme_Name);
    const d = String(r.TER_Date || '');
    const prev = out.get(k);
    if (prev && prev.date >= d) continue;
    const R = parseFloat(r.R_TER), D = parseFloat(r.D_TER);
    out.set(k, { R: isNaN(R) ? null : R, D: isNaN(D) ? null : D, date: d.slice(0, 10) });
  }
  return out;
}

export function addTer(schemes, amcs, terByAmc) {
  let matched = 0;
  for (const s of schemes) {
    if (s.s !== 'O') continue;
    const map = terByAmc.get(s.a);
    if (!map) continue;
    const t = map.get(norm(s.n)) || map.get(norm(s.n.replace(/\s+fund$/i, ''))) || map.get(norm(s.n + ' Fund'));
    if (t && (t.R !== null || t.D !== null)) { s.t = [t.R, t.D]; matched++; }
  }
  return matched;
}

// Pre-2017 generic labels AMFI still uses for some old schemes. They have no SEBI category.
export const LEGACY = new Set(['income', 'growth', 'otherdebtscheme', 'fixedtermplan']);

const HEADER = /^(Open Ended|Close Ended|Interval Fund)\s+Schemes?\s*\((.*)\)\s*$/i;
const PLAN_SEG = /^(direct|regular|retail|institutional|growth|idcw|dividend(?!\s+yield)|bonus|payout|reinvest|plan|option|daily|weekly|fortnightly|monthly|quarterly|half[\s-]?yearly|annual|yearly|segregated|unclaimed)\b/i;

// "HDFC Flexi Cap Fund - Direct Plan - Growth Option" -> "HDFC Flexi Cap Fund"
export function baseName(name) {
  const s = String(name).replace(/[–—]/g, '-');
  // Cut at the first separator ("-" or "(") that is followed by a plan/option word.
  // Hyphens inside names ("Small-Cap") are left alone because "Cap" isn't a plan word.
  let b = s;
  for (const m of s.matchAll(/\s*[-(]\s*/g)) {
    if (m.index === 0) continue;
    if (PLAN_SEG.test(s.slice(m.index + m[0].length))) { b = s.slice(0, m.index); break; }
  }
  // Names without separators: "SBI Nifty Index Fund Direct Growth"
  b = b.replace(/\s+(direct|regular)(\s+plan)?\b.*$/i, '')
       .replace(/\s+(growth|idcw)(\s+(option|plan))?\s*$/i, '')
       .replace(/[-\s]+$/g, '')
       .replace(/\s{2,}/g, ' ')
       .trim();
  return b || String(name).trim();
}

export function planOf(name) {
  return /\bdirect\b/i.test(name) ? 'D' : 'R';
}

export function parseNavAll(text, categories) {
  const aliasMap = buildAliasMap(categories);
  const amcs = [];
  const amcIndex = new Map();
  const groups = new Map(); // key -> scheme
  const unmapped = new Map(); // label -> count
  const labelsSeen = new Map();
  let structure = 'O', group = '', sub = '', label = '', cats = [], amc = -1;
  const dates = new Map();
  // Column positions, read from the "Scheme Code;..." header row. Defaults match the 8-column
  // layout AMFI uses since 2026 (code;isin;isin;name;plan;option;nav;date); the old 6-column
  // layout (no plan/option) is detected from its header too.
  let col = { name: 3, plan: 4, option: 5, nav: 6, date: 7 };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Scheme Code\s*;/i.test(line)) {
      const h = line.split(';').map((x) => x.trim().toLowerCase());
      const find = (re) => h.findIndex((x) => re.test(x));
      col = { name: find(/scheme name/), plan: find(/^plan$/), option: find(/^option$/), nav: find(/net asset value|^nav$/), date: find(/^date$/) };
      continue;
    }

    const h = line.match(HEADER);
    if (h) {
      structure = /^close/i.test(h[1]) ? 'C' : /^interval/i.test(h[1]) ? 'I' : 'O';
      label = h[2].trim();
      const i = label.indexOf(' - ');
      group = i >= 0 ? label.slice(0, i) : label;
      sub = i >= 0 ? label.slice(i + 3) : label;
      cats = mapLabel(group, sub, aliasMap);
      labelsSeen.set(label, (labelsSeen.get(label) || 0));
      continue;
    }

    const f = line.split(';');
    if (f.length < 6) {
      // AMC name line
      if (!amcIndex.has(line)) { amcIndex.set(line, amcs.length); amcs.push({ id: slug(line), name: line }); }
      amc = amcIndex.get(line);
      continue;
    }

    const t = f.map((x) => x.trim());
    const code = t[0];
    if (!/^\d+$/.test(code) || amc < 0) continue;
    // Take nav and date from the end so a stray ";" inside a scheme name can't shift them.
    const extra = t.length - (Math.max(col.name, col.plan, col.option, col.nav, col.date) + 1);
    const at = (i) => (i < 0 ? '' : i > col.name ? t[i + extra] : t[i]);
    const name = extra > 0 ? f.slice(col.name, col.name + 1 + extra).join(';').trim() : t[col.name];
    const plan = at(col.plan), option = at(col.option), nav = at(col.nav);
    const date = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(at(col.date)) ? at(col.date) : '';
    labelsSeen.set(label, (labelsSeen.get(label) || 0) + 1);
    if (!cats.length && structure === 'O' && !LEGACY.has(norm(sub))) unmapped.set(label, (unmapped.get(label) || 0) + 1);
    if (date) dates.set(date, (dates.get(date) || 0) + 1);

    const b = baseName(name);
    const key = amc + '|' + norm(b) + '|' + structure;
    let g = groups.get(key);
    if (!g) {
      g = { n: b, a: amc, c: refineCats(cats, b, label), l: label, s: structure, p: '', code: code, nav: null, d: '' };
      const k = kindOf(cats, b, label);
      if (k) g.k = k;
      groups.set(key, g);
    }
    const p = planOf(plan || name);
    // Growth-option codes for each plan, used to compute returns from NAV history.
    const growth = /growth/i.test(option || '') || (!option && /growth/i.test(name) && !/idcw|dividend(?!\s+yield)/i.test(name));
    if (growth && p === 'R' && !g.rc) g.rc = code;
    if (growth && p === 'D' && !g.dc) g.dc = code;
    if (!g.p.includes(p)) g.p = (g.p + p).split('').sort().reverse().join(''); // "R", "D", "RD"
    // Representative NAV: prefer Regular + Growth
    const isRegGrowth = p === 'R' && /growth/i.test(option || name);
    const n = parseFloat(nav);
    if (!isNaN(n) && (g.nav === null || isRegGrowth)) { g.nav = n; g.d = date; g.code = code; }
  }

  const schemes = [...groups.values()].sort((x, y) => x.a - y.a || x.n.localeCompare(y.n));
  const perAmc = amcs.map((_, i) => schemes.filter((s) => s.a === i).length);
  // The NAV date most schemes carry (a few stale schemes show older dates).
  const navDate = [...dates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return {
    navDate,
    amcs: amcs.map((a, i) => ({ ...a, schemes: perAmc[i] })),
    schemes,
    unmapped: [...unmapped.entries()].map(([label, count]) => ({ label, count })),
    labels: [...labelsSeen.entries()].map(([label, count]) => ({ label, count })),
  };
}

const MF_RE = /mutual funds?|\bMFs?\b|asset management|\bAMCs?\b|speciali[sz]ed investment funds?|\bSIFs?\b|unitholder|categori[sz]ation|scheme information|\bETFs?\b|index funds?|\bSWP\b|\bSTP\b|\bSIP\b|\bNAV\b|\bAMFI\b|mf lite|passive funds?/i;
export const isMF = (text) => MF_RE.test(text || '');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Sep 09, 2026", "24 Sep, 2026 +0530", "Thu, 26 Feb 2026 18:00:00 +0530" -> "2026-09-09"
export function isoDate(str) {
  const s = String(str || '');
  let m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/) ; // Sep 09, 2026
  let d, mo, y;
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; }
  else if ((m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/)) && MONTHS[m[2].toLowerCase()] !== undefined) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else return '';
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const decode = (x) => x.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// SEBI RSS: latest ~30 items of every kind (orders, press releases, circulars).
export function parseSebiRss(xml) {
  const items = [];
  const get = (block, tag) => {
    const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? decode(m[1]) : '';
  };
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const title = get(b, 'title');
    if (!title) continue;
    const link = get(b, 'link');
    items.push({ title, link, date: isoDate(get(b, 'pubDate')), type: typeFromLink(link), mf: isMF(title + ' ' + get(b, 'description')) });
  }
  return items;
}

// SEBI circulars listing page: <tr><td>Sep 09, 2026</td><td><a href="...">Title</a></td></tr>
export function parseSebiListing(html, type = 'Circular') {
  const items = [];
  // Split on row openings: SEBI's markup doesn't reliably close <tr> or <td>.
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = row.split(/<td[^>]*>/i).slice(1).map((c) => c.replace(/<\/td>[\s\S]*$/i, ''));
    if (cells.length < 2) continue;
    const date = isoDate(decode(cells[0]));
    const a = row.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([^<]*)/i); // no </a> needed
    if (!date || !a) continue;
    const titleAttr = a[0].match(/title=["']([^"']+)["']/i);
    const title = decode(titleAttr ? titleAttr[1] : a[2]);
    let link = a[1];
    if (link.startsWith('/')) link = 'https://www.sebi.gov.in' + link;
    items.push({ title, link, date, type, mf: isMF(title) });
  }
  return items;
}

function typeFromLink(link) {
  if (/\/circulars\//.test(link)) return 'Circular';
  if (/\/master-circulars\//.test(link)) return 'Master circular';
  if (/\/regulations\//.test(link)) return 'Regulation';
  if (/press-releases/.test(link)) return 'Press release';
  if (/consultation|reports-and-statistics\/reports/.test(link)) return 'Consultation';
  if (/enforcement|orders/.test(link)) return 'Order';
  return 'Update';
}
