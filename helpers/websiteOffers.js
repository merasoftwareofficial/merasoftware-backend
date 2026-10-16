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

const fetchLiveWebsiteOffers = async () => {
  const origin = process.env.PORTFOLIO_WEBSITE_URL;
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || "";
  if (!origin || secret.length < 32) {
    throw unavailable("Website offers are not configured on the server");
  }

  let response;
  try {
    response = await fetch(new URL("/api/offers/live", origin), {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw unavailable("Could not reach the website to load offers");
  }
  if (!response.ok) throw unavailable("The website did not return its offers");

  const result = await response.json();
  return (Array.isArray(result?.offers) ? result.offers : [])
    .filter((offer) => offer && typeof offer.slug === "string" && typeof offer.title === "string")
    .map((offer) => ({ slug: offer.slug, title: offer.title, endsAt: offer.endsAt || null }));
};

// The offer a project may be attached to — re-checked server-side at create time, because an
// offer listed in the form a minute ago may have been archived or expired since.
const findLiveWebsiteOffer = async (slug) => {
  const offers = await fetchLiveWebsiteOffers();
  return offers.find((offer) => offer.slug === slug) || null;
};

module.exports = { fetchLiveWebsiteOffers, findLiveWebsiteOffer };
