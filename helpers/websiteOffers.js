// Reads the live offers from the main website (merasoftware, Website Content → Offers) so an
// admin can attach one to a client project. The website is the only owner of offers — nothing is
// copied here except the slug + title frozen onto the project (projectSnapshot.offer).
//
// Reuses the existing portal → website integration (PORTFOLIO_WEBSITE_URL origin + the shared
// PORTFOLIO_INTEGRATION_SECRET bearer, see scripts/portfolioWorker.js). The website endpoint
// returns published, not-yet-expired offers only.

const unavailable = (message) => {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
};

const CACHE_TTL_MS = 5 * 60_000;
let cachedCatalogue = null;
let inflightCatalogue = null;
let cacheEpoch = 0;
let cacheInTest = false;

const isCacheEnabled = () => (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT && !process.execArgv.includes('--test')) || cacheInTest;
const clearWebsiteOffersCache = () => {
  cacheEpoch += 1;
  cachedCatalogue = null;
  inflightCatalogue = null;
};
const setWebsiteOffersCacheForTest = (enabled) => {
  cacheInTest = Boolean(enabled);
  clearWebsiteOffersCache();
};

const loadWebsiteCatalogue = async () => {
  const origin = process.env.PORTFOLIO_WEBSITE_URL;
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || "";
  if (!origin || secret.length < 32) {
    throw unavailable("Website offers are not configured on the server");
  }

  let response;
  try {
    response = await fetch(new URL("/api/offers/live", origin), {
      headers: { Authorization: `Bearer ${secret}` },
      cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw unavailable("Could not reach the website to load offers");
  }
  if (!response.ok) throw unavailable("The website did not return its offers");

  const result = await response.json();
  if (!Array.isArray(result?.offers)) throw unavailable("The website returned an invalid offers response");
  const offers = (Array.isArray(result.catalogueOffers) ? result.catalogueOffers : result.offers)
    .filter((offer) => offer && typeof offer.slug === "string" && typeof offer.title === "string")
    .map((offer) => ({ ...offer, endsAt: offer.endsAt || null }));
  // The website also owns the package pages (Pricing & Packages menu); a package may only be
  // assigned to a page that exists there. A website without the field sends none.
  const packagePages = (Array.isArray(result.packagePages) ? result.packagePages : [])
    .filter((page) => page && typeof page.slug === "string" && typeof page.title === "string")
    .map(({ slug, title }) => ({ slug, title }));
  return { offers, packagePages };
};

const fetchWebsiteCatalogue = async () => {
  if (!isCacheEnabled()) return loadWebsiteCatalogue();
  if (cachedCatalogue && cachedCatalogue.expiresAt > Date.now()) return cachedCatalogue.value;
  if (inflightCatalogue) return inflightCatalogue;

  const startEpoch = cacheEpoch;
  inflightCatalogue = loadWebsiteCatalogue()
    .then((value) => {
      // Do not store a stale response if an invalidation arrived mid-flight.
      if (cacheEpoch === startEpoch) {
        cachedCatalogue = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return value;
    })
    .finally(() => {
      if (cacheEpoch === startEpoch) inflightCatalogue = null;
    });
  return inflightCatalogue;
};
const fetchLiveWebsiteOffers = async () => (await fetchWebsiteCatalogue()).offers.filter(offer => (!offer.status || offer.status === 'published') && Date.parse(offer.endsAt) > Date.now());

// The offer a project may be attached to — re-checked server-side at create time, because an
// offer listed in the form a minute ago may have been archived or expired since.
const findLiveWebsiteOffer = async (slug) => {
  const offers = await fetchLiveWebsiteOffers();
  return offers.find((offer) => offer.slug === slug) || null;
};

module.exports = { fetchWebsiteCatalogue, fetchLiveWebsiteOffers, findLiveWebsiteOffer, clearWebsiteOffersCache, setWebsiteOffersCacheForTest };
