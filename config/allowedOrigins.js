const getAllowedOrigins = () => [
  'https://mera-software.vercel.app',
  'https://www.mera-software.vercel.app',
  'https://merasoftware.com',
  'https://www.merasoftware.com',
  'https://portal.merasoftware.com',
  'https://admin.merasoftware.com',
  'https://partner.merasoftware.com',
  'https://clone-merasoftware-frontend.vercel.app',
  process.env.FORNTEND_URL,
  process.env.STAFF_PORTAL_URL,
  process.env.ADMIN_PORTAL_URL,
  process.env.PARTNER_PORTAL_URL,
  'http://localhost:3000',
  // Local portal frontend; the website runs on 3000 (src/docs/login.md).
  'http://localhost:3001',
]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/$/, ''));

const isAllowedOrigin = (origin) => Boolean(origin)
  && getAllowedOrigins().includes(String(origin).replace(/\/$/, ''));

module.exports = { getAllowedOrigins, isAllowedOrigin };
