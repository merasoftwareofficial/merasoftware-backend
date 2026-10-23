// Test-only starter packages. Production has no built-in packages; tests seed these explicitly.
const starterScope = [
  'A single-page business website with a contact enquiry link',
  'Google Business Profile setup or optimisation',
  'Facebook and Instagram business profile setup',
  'WhatsApp Business profile and contact-link setup',
  'One branded social post design to introduce your business',
];
const terms = ['Domain, hosting, advertising spend and ongoing management are separate unless agreed in writing.', 'You provide business details, logo, photos and required account access.', 'Scope, delivery timeline and applicable taxes are confirmed before payment.'];
const STARTER_PACKAGES = [
  { id: 'starter', name: 'Business Starter', description: 'One-page website and business profile setup.', regularPrice: 10000, discountedPrice: 10000, offerExtraPrice: 0, inclusions: starterScope },
  { id: 'starter-plus', name: 'Business Starter Plus', description: 'Starter setup with a three-page website.', regularPrice: 12000, discountedPrice: 12000, offerExtraPrice: 2000, inclusions: ['A three-page business website with a contact enquiry link', ...starterScope.slice(1), 'Basic page titles and descriptions'] },
  { id: 'starter-complete', name: 'Business Starter Complete', description: 'Starter setup with five website pages and three social post designs.', regularPrice: 14000, discountedPrice: 14000, offerExtraPrice: 4000, inclusions: ['A five-page business website with a contact enquiry link', ...starterScope.slice(1, 4), 'Three branded social post designs', 'Basic page titles and descriptions'] },
].map((item, order) => ({ ...item, status: 'published', category: 'standard_websites', offerSlug: 'page', terms, linkedPlanIds: [], order }));
const seedStarterPackages = Catalogue => Catalogue.create({ _id: 'packages', packages: Object.fromEntries(STARTER_PACKAGES.map(item => [item.id, item])) });

module.exports = { STARTER_PACKAGES, seedStarterPackages };
