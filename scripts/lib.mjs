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
  const s = norm(sub);
  if (s.includes('lifecycle')) return ['life-cycle'];
  if (g.includes('debt') && s.includes('sectoral')) return ['sectoral-debt'];
  if (s.includes('fof') || s.includes('fundoffund')) return ['fof'];
  if (s.includes('etf') || s.includes('index')) return ['index-etf'];
  if (s.includes('elss') || s.includes('taxsaver')) return ['elss'];
  return [];
}

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
  let navDate = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Scheme Code\s*;/i.test(line)) continue;

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

    const [code, , , name, nav, date] = f.map((x) => x.trim());
    if (!/^\d+$/.test(code) || amc < 0) continue;
    labelsSeen.set(label, (labelsSeen.get(label) || 0) + 1);
    if (!cats.length && structure === 'O') unmapped.set(label, (unmapped.get(label) || 0) + 1);
    if (date && (!navDate || Date.parse(date) > Date.parse(navDate))) navDate = date;

    const b = baseName(name);
    const key = amc + '|' + norm(b) + '|' + structure;
    let g = groups.get(key);
    if (!g) {
      g = { n: b, a: amc, c: cats, l: label, s: structure, p: '', code: code, nav: null, d: '' };
      groups.set(key, g);
    }
    const p = planOf(name);
    if (!g.p.includes(p)) g.p = (g.p + p).split('').sort().reverse().join(''); // "R", "D", "RD"
    // Representative NAV: prefer Regular + Growth
    const isRegGrowth = p === 'R' && /growth/i.test(name);
    const n = parseFloat(nav);
    if (!isNaN(n) && (g.nav === null || isRegGrowth)) { g.nav = n; g.d = date; g.code = code; }
  }

  const schemes = [...groups.values()].sort((x, y) => x.a - y.a || x.n.localeCompare(y.n));
  const perAmc = amcs.map((_, i) => schemes.filter((s) => s.a === i).length);
  return {
    navDate,
    amcs: amcs.map((a, i) => ({ ...a, schemes: perAmc[i] })),
    schemes,
    unmapped: [...unmapped.entries()].map(([label, count]) => ({ label, count })),
    labels: [...labelsSeen.entries()].map(([label, count]) => ({ label, count })),
  };
}

const MF_RE = /mutual fund|\bMFs?\b|asset management|\bAMCs?\b|specialised investment fund|\bSIF\b|unitholder|categori[sz]ation|scheme information/i;

export function parseSebiRss(xml) {
  const items = [];
  const get = (block, tag) => {
    const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    if (!m) return '';
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
  };
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const title = get(b, 'title');
    const link = get(b, 'link');
    const date = get(b, 'pubDate');
    const desc = get(b, 'description');
    if (!title) continue;
    items.push({ title, link, date, mf: MF_RE.test(title + ' ' + desc) });
  }
  return items;
}
