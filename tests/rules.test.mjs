// Exhaustive check of the suggestion rules embedded in index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const block = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
const rulesSrc = block('/* ============ RULES-START', '/* ============ RULES-END');
const explainSrc = block('const EXPLAIN = {', 'const X = ');
const altSrc = block('const ALT_WHY = {', '/* ============ STATE');
const { RULES, EXPLAIN, ALT_WHY } = new Function(rulesSrc + explainSrc + altSrc + '; return { RULES, EXPLAIN, ALT_WHY };')();
const { categories } = JSON.parse(await readFile(new URL('../data/categories.json', import.meta.url), 'utf8'));
const ids = new Set(categories.filter((c) => c.status !== 'discontinued').map((c) => c.id));
const EQUITY = new Set(categories.filter((c) => c.group === 'equity').map((c) => c.id).concat(['aggressive-hybrid', 'balanced-hybrid', 'daaf', 'multi-asset', 'index-etf', 'life-cycle']));

const combos = [];
for (const purpose of ['emergency', 'goal', 'wealth', 'tax'])
  for (const horizon of RULES.HORIZONS)
    for (const risk of ['exit', 'hold', 'add'])
      for (const emergency of ['yes', 'no'])
        for (const regime of ['old', 'new', 'unsure'])
          for (const [mode, amount] of [['sip', 300], ['sip', 5000], ['lump', 500], ['lump', 50000], ['lump', 500000]])
            combos.push({ purpose, horizon, risk, emergency, regime, mode, amount });

test(`every one of ${combos.length} answer combinations gives a valid, explained result`, () => {
  for (const inp of combos) {
    const r = RULES.suggest(inp);
    const tag = JSON.stringify(inp);
    assert.ok(ids.has(r.primary), 'primary is an active category: ' + tag);
    assert.ok(r.alts.length >= 1 && r.alts.length <= 3, 'alts count: ' + tag);
    for (const a of r.alts) {
      assert.ok(ids.has(a), 'alt is an active category: ' + a);
      assert.notEqual(a, r.primary);
      assert.ok(ALT_WHY[a], 'ALT_WHY text for ' + a);
    }
    for (const k of [...r.reasons, ...r.teach, ...r.warnings, ...r.notes]) {
      assert.ok(EXPLAIN.en[k], 'English text for ' + k);
      assert.ok(EXPLAIN.ta[k], 'Tanglish text for ' + k);
    }
    assert.ok(r.reasons.length >= 1, 'at least one reason');
  }
});

test('safety rules hold', () => {
  for (const inp of combos) {
    const r = RULES.suggest(inp);
    const hi = RULES.HORIZONS.indexOf(inp.horizon);
    if (inp.purpose === 'emergency') assert.equal(r.primary, 'liquid');
    if (inp.purpose === 'emergency' || hi <= 2) assert.ok(!EQUITY.has(r.primary), 'no equity primary under 3 years or for emergencies: ' + JSON.stringify(inp));
    if (hi <= 1 || inp.purpose === 'emergency') for (const a of r.alts) assert.ok(!EQUITY.has(a), 'no equity alternative under 1 year');
    if (inp.purpose === 'tax' && inp.regime === 'new') assert.ok(r.primary !== 'elss' && !r.alts.includes('elss'), 'no ELSS for new regime');
    if (inp.purpose === 'tax' && inp.regime === 'old' && hi >= 3) assert.equal(r.primary, 'elss');
    if (inp.purpose === 'tax' && inp.regime !== 'new' && hi <= 2) assert.ok(r.primary !== 'elss' && r.teach.includes('t_elss_short'), 'ELSS not pushed for money needed within 3 years');
    if (inp.risk === 'exit' && hi >= 4 && inp.purpose !== 'emergency') assert.ok(r.teach.includes('t_ability_willingness'));
    if (inp.risk === 'exit') assert.ok(!['mid-cap', 'small-cap'].includes(r.primary), 'nervous investors never get mid/small cap as primary');
    if (r.primary === 'small-cap' || r.alts.includes('small-cap')) assert.ok(hi >= 6 && inp.risk === 'add', 'small cap only for 10+ years and high appetite');
    if (inp.emergency === 'no' && inp.purpose !== 'emergency' && EQUITY.has(r.primary)) assert.ok(r.warnings.includes('w_no_emergency'));
    if (inp.purpose === 'goal' && hi >= 4) assert.ok(r.alts.includes('life-cycle'), 'dated goals see Life Cycle Funds');
  }
});

test('spot checks', () => {
  const s = (o) => RULES.suggest({ purpose: 'wealth', emergency: 'yes', mode: 'sip', amount: 5000, regime: 'old', ...o });
  assert.equal(s({ horizon: 'h6', risk: 'hold' }).primary, 'flexi-cap');
  assert.equal(s({ horizon: 'h4', risk: 'hold' }).primary, 'large-cap');
  assert.equal(s({ horizon: 'h2', risk: 'hold' }).primary, 'short-term');
  assert.equal(s({ horizon: 'h0', risk: 'add' }).primary, 'liquid');
  assert.ok(s({ horizon: 'h6', risk: 'hold', mode: 'lump', amount: 500000 }).notes.includes('n_stp'));
});
