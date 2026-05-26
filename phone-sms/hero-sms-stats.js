// phone-sms/hero-sms-stats.js — HeroSMS 热门便宜号码排序的纯函数模块
//
// 数据来源：
//   1. https://hero-sms.com/api/v1/stats/deliverability  → Top10 解码率（需 session cookie）
//   2. handler_api.php?action=getPrices                  → 单价 + 物理库存（api_key 鉴权）
//   3. handler_api.php?action=getCountries               → id → 国家中英名映射（api_key 鉴权）
//
// 本模块只负责把三份数据合并、排序、格式化，不发起任何网络请求。
(function attachHeroSmsStats(root, factory) {
  root.PhoneSmsHeroSmsStats = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHeroSmsStatsModule() {
  function normalizeDeliverability(raw) {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
    return arr
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = Math.floor(Number(entry.country));
        const percent = Number(entry.percent);
        if (!Number.isFinite(id) || id <= 0) return null;
        if (!Number.isFinite(percent)) return null;
        return {
          countryId: id,
          service: String(entry.service || '').trim(),
          successPercent: percent,
        };
      })
      .filter(Boolean);
  }

  function normalizePrices(raw, service) {
    const normalizedService = String(service || '').trim().toLowerCase();
    if (!raw || typeof raw !== 'object') return {};
    const result = {};
    for (const [countryKey, services] of Object.entries(raw)) {
      if (!services || typeof services !== 'object') continue;
      const id = Math.floor(Number(countryKey));
      if (!Number.isFinite(id) || id <= 0) continue;
      const entry = services[normalizedService];
      if (!entry || typeof entry !== 'object') continue;
      const cost = Number(entry.cost);
      const count = Number(entry.count);
      const physical = Number(entry.physicalCount ?? entry.physical ?? 0);
      result[id] = {
        cost: Number.isFinite(cost) ? cost : 0,
        count: Number.isFinite(count) ? count : 0,
        physical: Number.isFinite(physical) ? physical : 0,
      };
    }
    return result;
  }

  function normalizeCountries(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const result = {};
    for (const [countryKey, info] of Object.entries(raw)) {
      const id = Math.floor(Number(countryKey));
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!info || typeof info !== 'object') continue;
      result[id] = {
        chn: String(info.chn || '').trim() || `#${id}`,
        eng: String(info.eng || '').trim() || `#${id}`,
        rus: String(info.rus || '').trim() || '',
      };
    }
    return result;
  }

  /**
   * Merge deliverability rows with prices + country names. Returns the same
   * rows ordered as the deliverability API returned them (it is already
   * Top10 by success rate); each row is enriched with cost/physical/count
   * and chn/eng country labels, plus an `unavailable` flag when physical
   * stock is 0 so the UI can highlight risky picks.
   */
  function enrichHeroSmsTopStats({ deliverability, prices, countries, service = 'dr' } = {}) {
    const deliv = normalizeDeliverability(deliverability);
    const priceMap = normalizePrices(prices, service);
    const countryMap = normalizeCountries(countries);

    return deliv.map((row, index) => {
      const price = priceMap[row.countryId] || { cost: 0, count: 0, physical: 0 };
      const country = countryMap[row.countryId] || { chn: `#${row.countryId}`, eng: `#${row.countryId}` };
      return {
        rank: index + 1,
        countryId: row.countryId,
        chn: country.chn,
        eng: country.eng,
        service: row.service || service,
        successPercent: row.successPercent,
        cost: price.cost,
        physicalCount: price.physical,
        virtualCount: price.count,
        unavailable: price.physical <= 0,
      };
    });
  }

  /**
   * Build a recommended subset: physical stock > 0, sorted by success-rate
   * desc, then cost asc. Useful for an "actionable picks" callout in the UI.
   */
  function recommendHeroSmsTopStats(enriched = []) {
    return enriched
      .filter((row) => row && row.physicalCount > 0 && row.cost > 0)
      .slice()
      .sort((a, b) => (b.successPercent - a.successPercent) || (a.cost - b.cost));
  }

  /**
   * Parse a single country's offer response from
   *   GET /api/v1/left-menu/service/<service>/country/<id>/offers
   * The response shape is `{ data: { <service>: { operators: [...] } } }`.
   * Each operator has `freePriceOffers: { "0.025": 5, "0.05": 200, ... }`
   * (price string → currently buyable count at that tier).
   *
   * Returns a flat summary:
   *   minAvailableCost   = lowest tier price where count > 0 across all operators
   *                        (= what you'd actually pay if you bought right now)
   *   totalAvailable     = sum of all tier counts across all operators
   *                        (= total numbers you can buy right now at any tier)
   *   totalPhysical      = sum of countPhysical across all operators
   *   bestOperator       = name of the operator that offers minAvailableCost
   *   tierBreakdown      = sorted [{cost, count, operator}] for top 5 cheapest
   *                        tiers; useful for diagnostic UI
   * If no tier has any availability, returns `{ minAvailableCost: 0, totalAvailable: 0, ... }`.
   */
  function extractMinAvailableOffer(rawResponse, service = 'dr') {
    const normalizedService = String(service || '').trim().toLowerCase();
    const serviceBlock = rawResponse?.data?.[normalizedService]
      || rawResponse?.[normalizedService]
      || null;
    const operators = Array.isArray(serviceBlock?.operators) ? serviceBlock.operators : [];

    const tiers = [];
    let totalAvailable = 0;
    let totalPhysical = 0;
    for (const op of operators) {
      if (!op || typeof op !== 'object') continue;
      const opName = String(op.name || op.localName || '').trim() || 'any';
      totalPhysical += Math.max(0, Number(op.countPhysical) || 0);
      const offers = op.freePriceOffers;
      if (!offers || typeof offers !== 'object') continue;
      for (const [priceKey, countValue] of Object.entries(offers)) {
        const cost = Number(priceKey);
        const count = Math.max(0, Number(countValue) || 0);
        if (!Number.isFinite(cost) || cost <= 0 || count <= 0) continue;
        tiers.push({ cost, count, operator: opName });
        totalAvailable += count;
      }
    }
    tiers.sort((a, b) => a.cost - b.cost);
    const minTier = tiers[0] || null;
    return {
      minAvailableCost: minTier ? minTier.cost : 0,
      totalAvailable,
      totalPhysical,
      bestOperator: minTier ? minTier.operator : '',
      tierBreakdown: tiers.slice(0, 5),
    };
  }

  /**
   * Overlay per-country offer data onto an already-enriched rows array.
   * Each row gets:
   *   minAvailableCost   - the actual cheapest currently-buyable price
   *   totalAvailable     - total numbers buyable right now (sum across tiers)
   *   bestOperator       - which operator offers that price
   *   tierBreakdown      - top 5 cheapest tier entries
   * The original `cost` (starting price) is preserved as `startingCost` so
   * callers can still surface it as a tooltip if they want.
   * `unavailable` is recomputed: now means "no tier has any count > 0".
   */
  function mergeOffersIntoEnriched(enriched = [], offersByCountry = {}) {
    return enriched.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const offerRaw = offersByCountry[row.countryId];
      if (!offerRaw) {
        // Offer query failed for this country - keep the row but mark as
        // "no offer data" so UI can fall back to starting price.
        return {
          ...row,
          startingCost: row.cost,
          minAvailableCost: 0,
          totalAvailable: 0,
          bestOperator: '',
          tierBreakdown: [],
          offerLookupFailed: true,
        };
      }
      const summary = extractMinAvailableOffer(offerRaw, row.service);
      return {
        ...row,
        startingCost: row.cost,
        minAvailableCost: summary.minAvailableCost,
        totalAvailable: summary.totalAvailable,
        bestOperator: summary.bestOperator,
        tierBreakdown: summary.tierBreakdown,
        offerLookupFailed: false,
        // Replace top-level cost with the actually-buyable price so existing
        // sort/format logic in the UI uses the meaningful number. If no tier
        // is currently available, cost stays at startingCost (so user still
        // sees something) but unavailable flips to true.
        cost: summary.minAvailableCost > 0 ? summary.minAvailableCost : row.cost,
        physicalCount: summary.totalAvailable > 0 ? summary.totalAvailable : row.physicalCount,
        unavailable: summary.totalAvailable <= 0,
      };
    });
  }

  function formatCost(cost) {
    if (!Number.isFinite(cost) || cost <= 0) return '-';
    return `$${cost.toFixed(4)}`;
  }

  function formatPercent(percent) {
    if (!Number.isFinite(percent)) return '-';
    return `${percent.toFixed(2)}%`;
  }

  return {
    enrichHeroSmsTopStats,
    recommendHeroSmsTopStats,
    extractMinAvailableOffer,
    mergeOffersIntoEnriched,
    normalizeDeliverability,
    normalizePrices,
    normalizeCountries,
    formatCost,
    formatPercent,
  };
});
