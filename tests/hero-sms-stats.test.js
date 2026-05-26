const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const moduleSource = fs.readFileSync('phone-sms/hero-sms-stats.js', 'utf8');
const scope = {};
const api = new Function('self', `${moduleSource}; return self.PhoneSmsHeroSmsStats;`)(scope);

const deliverabilityFixture = {
  data: [
    { country: 52, service: 'dr', percent: 75.94 },
    { country: 33, service: 'dr', percent: 54.81 },
    { country: 182, service: 'dr', percent: 52.42 },
    { country: 151, service: 'dr', percent: 39.42 },
    { country: 73, service: 'dr', percent: 26.17 },
  ],
};

const pricesFixture = {
  52: { dr: { cost: 0.45, count: 1049, physicalCount: 1049 } },
  33: { dr: { cost: 0.05, count: 4059, physicalCount: 3656 } },
  182: { dr: { cost: 0.35, count: 24, physicalCount: 0 } },
  151: { dr: { cost: 0.025, count: 11994, physicalCount: 1028 } },
  73: { dr: { cost: 0.025, count: 31815, physicalCount: 1033 } },
};

const countriesFixture = {
  52: { id: 52, chn: '泰国', eng: 'Thailand' },
  33: { id: 33, chn: '哥伦比亚', eng: 'Colombia' },
  182: { id: 182, chn: '日本', eng: 'Japan' },
  151: { id: 151, chn: '智利', eng: 'Chile' },
  73: { id: 73, chn: '巴西', eng: 'Brazil' },
};

test('enrichHeroSmsTopStats merges deliverability + prices + country names in deliverability order', () => {
  const rows = api.enrichHeroSmsTopStats({
    deliverability: deliverabilityFixture,
    prices: pricesFixture,
    countries: countriesFixture,
    service: 'dr',
  });

  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    rank: 1,
    countryId: 52,
    chn: '泰国',
    eng: 'Thailand',
    service: 'dr',
    successPercent: 75.94,
    cost: 0.45,
    physicalCount: 1049,
    virtualCount: 1049,
    unavailable: false,
  });
  // Japan has physical=0 → unavailable flag set so UI can warn user
  const japan = rows.find((r) => r.countryId === 182);
  assert.equal(japan.unavailable, true);
  assert.equal(japan.physicalCount, 0);
});

test('enrichHeroSmsTopStats falls back to #id country name when country mapping missing', () => {
  const rows = api.enrichHeroSmsTopStats({
    deliverability: { data: [{ country: 999, service: 'dr', percent: 10 }] },
    prices: { 999: { dr: { cost: 0.1, count: 5, physicalCount: 5 } } },
    countries: {},
    service: 'dr',
  });
  assert.equal(rows[0].chn, '#999');
  assert.equal(rows[0].eng, '#999');
});

test('enrichHeroSmsTopStats yields cost=0 + unavailable when prices missing for country', () => {
  const rows = api.enrichHeroSmsTopStats({
    deliverability: { data: [{ country: 52, service: 'dr', percent: 70 }] },
    prices: {},
    countries: countriesFixture,
    service: 'dr',
  });
  assert.equal(rows[0].cost, 0);
  assert.equal(rows[0].physicalCount, 0);
  assert.equal(rows[0].unavailable, true);
});

test('recommendHeroSmsTopStats filters out zero-physical and sorts by success rate then cost', () => {
  const enriched = api.enrichHeroSmsTopStats({
    deliverability: deliverabilityFixture,
    prices: pricesFixture,
    countries: countriesFixture,
    service: 'dr',
  });
  const recommended = api.recommendHeroSmsTopStats(enriched);
  // Japan (182, physical=0) filtered out
  assert.equal(recommended.find((r) => r.countryId === 182), undefined);
  // Order: 75.94 → 54.81 → 39.42 → 26.17
  assert.deepEqual(
    recommended.map((r) => r.countryId),
    [52, 33, 151, 73]
  );
});

test('recommendHeroSmsTopStats breaks ties by cost ascending', () => {
  const enriched = api.enrichHeroSmsTopStats({
    deliverability: {
      data: [
        { country: 1, service: 'dr', percent: 40 },
        { country: 2, service: 'dr', percent: 40 },
        { country: 3, service: 'dr', percent: 40 },
      ],
    },
    prices: {
      1: { dr: { cost: 0.3, count: 10, physicalCount: 10 } },
      2: { dr: { cost: 0.05, count: 10, physicalCount: 10 } },
      3: { dr: { cost: 0.1, count: 10, physicalCount: 10 } },
    },
    countries: {
      1: { chn: 'A', eng: 'A' },
      2: { chn: 'B', eng: 'B' },
      3: { chn: 'C', eng: 'C' },
    },
    service: 'dr',
  });
  const recommended = api.recommendHeroSmsTopStats(enriched);
  // All 40%, sort by cost asc: 0.05 → 0.1 → 0.3
  assert.deepEqual(
    recommended.map((r) => r.countryId),
    [2, 3, 1]
  );
});

test('normalizeDeliverability tolerates bare arrays, dropped rows, and malformed entries', () => {
  const rows = api.normalizeDeliverability([
    { country: 5, percent: 12.3 },
    { country: 'abc', percent: 10 },
    { country: 7, percent: 'nope' },
    null,
    { country: 0, percent: 5 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].countryId, 5);
});

test('formatters render readable values for the UI', () => {
  assert.equal(api.formatCost(0.025), '$0.0250');
  assert.equal(api.formatCost(0), '-');
  assert.equal(api.formatCost(NaN), '-');
  assert.equal(api.formatPercent(75.94), '75.94%');
  assert.equal(api.formatPercent(undefined), '-');
});

test('extractMinAvailableOffer finds the cheapest tier with count > 0 across all operators', () => {
  // Realistic Colombia (33) response: claro has $0.10 with 403 numbers, others empty
  const colombia = {
    data: {
      dr: {
        operators: [
          { name: 'claro', activationsCount: 403, countPhysical: 403, freePriceOffers: { '0.1000': 403 } },
          { name: 'etb', activationsCount: 0, countPhysical: 0, freePriceOffers: null },
        ],
      },
    },
  };
  const s = api.extractMinAvailableOffer(colombia, 'dr');
  assert.equal(s.minAvailableCost, 0.1);
  assert.equal(s.totalAvailable, 403);
  assert.equal(s.totalPhysical, 403);
  assert.equal(s.bestOperator, 'claro');
  assert.equal(s.tierBreakdown.length, 1);
  assert.deepEqual(s.tierBreakdown[0], { cost: 0.1, count: 403, operator: 'claro' });
});

test('extractMinAvailableOffer picks the lowest tier when operators offer multiple tiers', () => {
  const multi = {
    data: {
      dr: {
        operators: [
          { name: 'op_a', countPhysical: 100, freePriceOffers: { '0.05': 0, '0.075': 50, '0.15': 30 } },
          { name: 'op_b', countPhysical: 200, freePriceOffers: { '0.025': 10, '0.08': 100 } },
        ],
      },
    },
  };
  const s = api.extractMinAvailableOffer(multi, 'dr');
  assert.equal(s.minAvailableCost, 0.025);
  assert.equal(s.bestOperator, 'op_b');
  assert.equal(s.totalAvailable, 10 + 50 + 30 + 100); // 190; ignores the 0-count $0.05 tier
  assert.deepEqual(
    s.tierBreakdown.map((t) => `${t.cost}@${t.operator}`),
    ['0.025@op_b', '0.075@op_a', '0.08@op_b', '0.15@op_a']
  );
});

test('extractMinAvailableOffer returns zeros when no tier has stock', () => {
  const empty = {
    data: {
      dr: {
        operators: [
          { name: 'op_a', countPhysical: 0, freePriceOffers: null },
          { name: 'op_b', countPhysical: 0, freePriceOffers: { '0.05': 0 } },
        ],
      },
    },
  };
  const s = api.extractMinAvailableOffer(empty, 'dr');
  assert.equal(s.minAvailableCost, 0);
  assert.equal(s.totalAvailable, 0);
  assert.equal(s.bestOperator, '');
});

test('mergeOffersIntoEnriched replaces cost/physical with real-time tier data and flags missing lookups', () => {
  const enriched = api.enrichHeroSmsTopStats({
    deliverability: deliverabilityFixture,
    prices: pricesFixture,
    countries: countriesFixture,
    service: 'dr',
  });
  const offersByCountry = {
    52: { data: { dr: { operators: [{ name: 'a', countPhysical: 500, freePriceOffers: { '0.45': 500 } }] } } },
    33: { data: { dr: { operators: [{ name: 'claro', countPhysical: 403, freePriceOffers: { '0.10': 403 } }] } } },
    // 182 (Japan) intentionally missing - simulate failed lookup
    151: { data: { dr: { operators: [{ name: 'a', countPhysical: 0, freePriceOffers: null }] } } }, // empty
    73: { data: { dr: { operators: [{ name: 'a', countPhysical: 200, freePriceOffers: { '0.025': 200 } }] } } },
  };
  const merged = api.mergeOffersIntoEnriched(enriched, offersByCountry);

  const colombia = merged.find((r) => r.countryId === 33);
  // Starting price was 0.05; real currently-buyable is 0.10
  assert.equal(colombia.startingCost, 0.05);
  assert.equal(colombia.cost, 0.10);
  assert.equal(colombia.minAvailableCost, 0.10);
  assert.equal(colombia.totalAvailable, 403);
  assert.equal(colombia.unavailable, false);
  assert.equal(colombia.bestOperator, 'claro');

  // Chile has no actual tier stock → unavailable=true even though physicalCount in prices was 1028
  const chile = merged.find((r) => r.countryId === 151);
  assert.equal(chile.unavailable, true);
  assert.equal(chile.totalAvailable, 0);

  // Japan lookup missing → offerLookupFailed=true, cost stays at starting price
  const japan = merged.find((r) => r.countryId === 182);
  assert.equal(japan.offerLookupFailed, true);
  assert.equal(japan.cost, japan.startingCost);
});
