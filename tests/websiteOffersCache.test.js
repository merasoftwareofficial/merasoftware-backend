const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWebsiteCatalogue,
  clearWebsiteOffersCache,
  setWebsiteOffersCacheForTest,
} = require('../helpers/websiteOffers');

const withEnv = async (fn) => {
  const prevUrl = process.env.PORTFOLIO_WEBSITE_URL;
  const prevSecret = process.env.PORTFOLIO_INTEGRATION_SECRET;
  const prevFetch = global.fetch;
  process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example';
  process.env.PORTFOLIO_INTEGRATION_SECRET = 'x'.repeat(32);
  setWebsiteOffersCacheForTest(true);
  try {
    await fn();
  } finally {
    setWebsiteOffersCacheForTest(false);
    global.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.PORTFOLIO_WEBSITE_URL;
    else process.env.PORTFOLIO_WEBSITE_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.PORTFOLIO_INTEGRATION_SECRET;
    else process.env.PORTFOLIO_INTEGRATION_SECRET = prevSecret;
  }
};

test('websiteOffers caches responses, deduplicates concurrent fetches, and clears on invalidation', async () => {
  await withEnv(async () => {
    let calls = 0;
    let version = 1;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          offers: [{ slug: `offer-v${version}`, title: `Offer ${version}`, status: 'published', endsAt: '2099-01-01T00:00:00.000Z' }],
          packagePages: [{ slug: 'web', title: 'Web' }],
        }),
      };
    };

    const [a, b] = await Promise.all([fetchWebsiteCatalogue(), fetchWebsiteCatalogue()]);
    assert.equal(calls, 1);
    assert.equal(a.offers[0].slug, 'offer-v1');
    assert.equal(b.offers[0].slug, 'offer-v1');

    const c = await fetchWebsiteCatalogue();
    assert.equal(calls, 1);
    assert.equal(c.offers[0].slug, 'offer-v1');

    version = 2;
    clearWebsiteOffersCache();
    const d = await fetchWebsiteCatalogue();
    assert.equal(calls, 2);
    assert.equal(d.offers[0].slug, 'offer-v2');
  });
});

test('websiteOffers does not cache stale response when invalidated mid-flight', async () => {
  await withEnv(async () => {
    let calls = 0;
    let releaseFirst;
    const firstPending = new Promise((resolve) => { releaseFirst = resolve; });

    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        await firstPending;
        return {
          ok: true,
          json: async () => ({ offers: [{ slug: 'stale', title: 'Stale' }], packagePages: [] }),
        };
      }
      return {
        ok: true,
        json: async () => ({ offers: [{ slug: 'fresh', title: 'Fresh' }], packagePages: [] }),
      };
    };

    const p1 = fetchWebsiteCatalogue();
    await new Promise((r) => setTimeout(r, 10));
    clearWebsiteOffersCache();
    releaseFirst();

    const firstResult = await p1;
    assert.equal(firstResult.offers[0].slug, 'stale');

    const secondResult = await fetchWebsiteCatalogue();
    assert.equal(calls, 2);
    assert.equal(secondResult.offers[0].slug, 'fresh');
  });
});
