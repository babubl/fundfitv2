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
      g = { n: b, a: amc, c: cats, l: label, s: structure, p: '', code: code, nav: null, d: '' };
      groups.set(key, g);
    }
    const p = planOf(plan || name);
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
