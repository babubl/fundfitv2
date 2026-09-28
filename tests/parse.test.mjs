// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNavAll, parseSebiRss, baseName } from '../scripts/lib.mjs';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const { categories, groups } = JSON.parse(await read('../data/categories.json'));

test('category counts match the Feb 2026 circular', () => {
  const active = (g) => categories.filter((c) => c.group === g && c.status !== 'discontinued').length;
  assert.equal(active('equity'), 13);
  assert.equal(active('debt'), 17);
  assert.equal(active('hybrid'), 7);
  assert.equal(active('lifecycle'), 1);
  assert.equal(active('other'), 2);
  assert.equal(categories.filter((c) => c.status === 'discontinued').length, 2);
  for (const g of groups) assert.equal(active(g.id), g.count2026, g.id);
  assert.equal(new Set(categories.map((c) => c.id)).size, categories.length, 'unique ids');
});

test('base names strip plan and option suffixes', () => {
  assert.equal(baseName('HDFC Flexi Cap Fund - Direct Plan - Growth Option'), 'HDFC Flexi Cap Fund');
  assert.equal(baseName('Beta Banking & Financial Services Fund-Growth Option-Direct Plan'), 'Beta Banking & Financial Services Fund');
  assert.equal(baseName('SBI Nifty Index Fund Direct Growth'), 'SBI Nifty Index Fund');
  assert.equal(baseName('Alpha Dividend Yield Fund - Direct - IDCW'), 'Alpha Dividend Yield Fund');
  assert.equal(baseName('Nippon India ETF Nifty 50 BeES'), 'Nippon India ETF Nifty 50 BeES');
});

test('AMFI NAVAll parsing', async () => {
  const r = parseNavAll(await read('fixtures/NAVAll.sample.txt'), categories);
  assert.deepEqual(r.amcs.map((a) => a.name), ['Alpha Mutual Fund', 'Beta Mutual Fund', 'Gamma Mutual Fund']);
  const byName = Object.fromEntries(r.schemes.map((s) => [s.n, s]));

  const low = byName['Alpha Low Duration Fund'];
  assert.deepEqual(low.c, ['ultra-short-to-short'], 'old 2017 label maps to renamed 2026 category');
  assert.equal(low.p, 'RD');
  assert.equal(low.nav, 3210.1234, 'representative NAV is Regular Growth');

  assert.deepEqual(byName['Beta Ultra Short to Short Term Fund'].c, ['ultra-short-to-short']);
  assert.equal(byName['Beta Ultra Short to Short Term Fund'].p, 'D');
  assert.deepEqual(byName['Alpha Dividend Yield Fund'].c, ['dividend-yield']);
  assert.deepEqual(byName['Beta Banking & Financial Services Fund'].c, ['sectoral', 'thematic']);
  assert.deepEqual(byName['Beta Infrastructure Debt Sectoral Fund'].c, ['sectoral-debt'], 'debt "Sectoral Fund" is not equity sectoral');
  assert.deepEqual(byName['Gamma Life Cycle Fund 2045'].c, ['life-cycle']);
  assert.deepEqual(byName['Gamma US Equity Passive FOF'].c, ['fof']);
  assert.equal(byName['Alpha Fixed Term Plan Series 12'].s, 'C');

  assert.deepEqual(r.unmapped, [{ label: 'Other Scheme - Brand New Label', count: 1 }]);
  assert.equal(r.navDate, '26-Sep-2026');
  assert.equal(r.schemes.length, 9);
});

test('SEBI RSS parsing flags MF items', async () => {
  const items = parseSebiRss(await read('fixtures/sebi.sample.xml'));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.mf), [true, false, true]);
  assert.equal(items[0].title, 'Categorization and Rationalization of Mutual Fund Schemes');
});
