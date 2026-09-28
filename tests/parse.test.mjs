// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNavAll, parseSebiRss, parseSebiListing, baseName, parseNavHistory, addReturns, cagr, parseTer, addTer, kindOf } from '../scripts/lib.mjs';

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

test('AMFI NAVAll parsing, old 6-column layout', async () => {
  const r = parseNavAll(await read('fixtures/NAVAll.old6.sample.txt'), categories);
  assert.deepEqual(r.amcs.map((a) => a.name), ['Alpha Mutual Fund', 'Beta Mutual Fund', 'Gamma Mutual Fund']);
  const byName = Object.fromEntries(r.schemes.map((s) => [s.n, s]));

  const low = byName['Alpha Low Duration Fund'];
  assert.deepEqual(low.c, ['ultra-short-to-short'], 'old 2017 label maps to renamed 2026 category');
  assert.equal(low.p, 'RD');
  assert.equal(low.nav, 3210.1234, 'representative NAV is Regular Growth');

  assert.deepEqual(byName['Beta Ultra Short to Short Term Fund'].c, ['ultra-short-to-short']);
  assert.equal(byName['Beta Ultra Short to Short Term Fund'].p, 'D');
  assert.deepEqual(byName['Alpha Dividend Yield Fund'].c, ['dividend-yield']);
  assert.deepEqual(byName['Beta Banking & Financial Services Fund'].c, ['sectoral'], 'shared sectoral/thematic label split by name');
  assert.deepEqual(byName['Beta Infrastructure Debt Sectoral Fund'].c, ['sectoral-debt'], 'debt "Sectoral Fund" is not equity sectoral');
  assert.deepEqual(byName['Gamma Life Cycle Fund 2045'].c, ['life-cycle']);
  assert.deepEqual(byName['Gamma US Equity Passive FOF'].c, ['fof']);
  assert.equal(byName['Alpha Fixed Term Plan Series 12'].s, 'C');

  assert.deepEqual(r.unmapped, [{ label: 'Other Scheme - Brand New Label', count: 1 }]);
  assert.equal(r.navDate, '26-Sep-2026');
  assert.equal(r.schemes.length, 9);
});

test('AMFI NAVAll parsing, current 8-column layout with Plan and Option', async () => {
  const r = parseNavAll(await read('fixtures/NAVAll.sample.txt'), categories);
  assert.deepEqual(r.amcs.map((a) => a.name), ['Axis Mutual Fund', 'Zerodha Mutual Fund']);
  const by = Object.fromEntries(r.schemes.map((s) => [s.n, s]));

  const kids = by["Axis Children's Fund"];
  assert.deepEqual(kids.c, ['children'], 'curly-apostrophe label maps');
  assert.equal(kids.p, 'RD', 'plan read from the Plan column');
  assert.equal(kids.nav, 25.8499, 'representative NAV is Regular + Growth');
  assert.equal(kids.d, '25-Sep-2026');

  assert.deepEqual(by['Axis Low Duration Fund'].c, ['ultra-short-to-short'], 'new-style debt label');
  assert.deepEqual(by['Axis Balanced Advantage Fund'].c, ['daaf']);
  assert.deepEqual(by['Zerodha Nifty LargeMidcap 250 Index Fund'].c, ['index-etf'], 'index group label');
  assert.equal(by['Zerodha Nifty LargeMidcap 250 Index Fund'].p, 'D');
  assert.deepEqual(by['Zerodha Silver ETF'].c, ['index-etf'], 'ETF group label');
  assert.deepEqual(by['Zerodha Financial Services Debt Fund; Series A'].c, ['sectoral-debt'], 'semicolon in name');
  assert.equal(by['Zerodha Financial Services Debt Fund; Series A'].nav, 10.02, 'semicolon in name does not shift NAV');
  assert.deepEqual(by['Zerodha Business Cycles Fund'].c, ['thematic']);
  assert.deepEqual(by['Axis Old Gilt Plan'].c, ['gilt'], 'legacy "Gilt" label');
  assert.deepEqual(by['Axis Old Income Plan'].c, [], 'legacy "Income" has no category');
  assert.deepEqual(by['Axis Life Cycle Fund 2035'].c, ['life-cycle']);

  assert.deepEqual(r.unmapped, [], 'legacy labels are not reported as unmapped');
  assert.equal(r.navDate, '25-Sep-2026', 'most common date, not the latest stray one');
});

test('SEBI RSS parsing flags MF items and normalises dates', async () => {
  const items = parseSebiRss(await read('fixtures/sebi.sample.xml'));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.mf), [true, false, true]);
  assert.equal(items[0].title, 'Categorization and Rationalization of Mutual Fund Schemes');
  assert.equal(items[0].date, '2026-02-26');
  assert.equal(items[1].date, '2026-09-25');
});

test('SEBI circulars listing parsing', async () => {
  const items = parseSebiListing(await read('fixtures/sebi.listing.sample.html'));
  assert.equal(items.length, 5, 'rows without closing </tr> or </td> still parse');
  assert.deepEqual(items.map((i) => i.mf), [false, true, true, true, false]);
  assert.equal(items[3].title, 'Intraday borrowing facility availed by mutual funds');
  assert.equal(items[0].title.startsWith('Review of Position Limits for Clients and Penalty'), true, 'full title from title attribute');
  assert.equal(items[2].link, 'https://www.sebi.gov.in/legal/circulars/jul-2026/swp-stp-demat_102914.html', 'relative link made absolute');
  assert.equal(items[1].date, '2026-07-21');
  assert.equal(items[1].type, 'Circular');
});

test('growth codes, NAV history returns and fund age', async () => {
  const text = await read('fixtures/NAVAll.sample.txt');
  const r = parseNavAll(text, categories);
  const kids = r.schemes.find((s) => s.n === "Axis Children's Fund");
  assert.equal(kids.rc, '135759'); assert.equal(kids.dc, '135762');
  const hist = parseNavHistory(await read('fixtures/NAVHistory.sample.txt'));
  assert.equal(hist.navs.get('135759'), 12.925);
  assert.equal(hist.navs.get('200040'), 9.5, 'semicolon in name');
  addReturns(r.schemes, parseNavHistory(text).navs, [{ years: 1, navs: new Map() }, { years: 3, navs: hist.navs }, { years: 5, navs: new Map() }]);
  assert.deepEqual(kids.r.R, [null, cagr(25.8499, 12.925, 3), null]);
  assert.equal(kids.r.R[1], 26, '3-year CAGR of doubling is about 26%');
  assert.equal(kids.y, 3);
});

test('TER parsing keeps the latest date and matches by scheme name', () => {
  const ter = parseTer([
    { Scheme_Name: 'Axis Low Duration Fund', TER_Date: '2026-08-01T00:00:00Z', R_TER: '1.0', D_TER: '0.4' },
    { Scheme_Name: 'Axis Low Duration Fund', TER_Date: '2026-08-26T00:00:00Z', R_TER: '0.95', D_TER: '0.35' },
  ]);
  const schemes = [{ n: 'Axis Low Duration Fund', a: 0, s: 'O' }, { n: 'Axis Other Fund', a: 0, s: 'O' }];
  assert.equal(addTer(schemes, [], new Map([[0, ter]])), 1);
  assert.deepEqual(schemes[0].t, [0.95, 0.35]);
  assert.equal(schemes[1].t, undefined);
});

test('index funds and ETFs are tagged by what they track', () => {
  const k = (n, l = 'Index Funds - Equity Funds') => kindOf(['index-etf'], n, l);
  assert.equal(k('Nippon India ETF Gold BeES', 'Other Scheme - Gold ETF'), 'gold');
  assert.equal(k('Zerodha Silver ETF'), 'silver');
  assert.equal(k('Bharat Bond ETF April 2030'), 'debt');
  assert.equal(k('SBI CRISIL IBX Gilt Index Fund', 'Index Funds - Debt Funds'), 'debt');
  assert.equal(k('Motilal Oswal Nasdaq 100 ETF'), 'intl');
  assert.equal(k('UTI Nifty 50 Index Fund'), 'equity');
  assert.equal(kindOf(['large-cap'], 'X', 'Y'), '');
});
