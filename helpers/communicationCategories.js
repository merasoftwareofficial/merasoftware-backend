// Categories for Communication > Actions, in the order the page shows them. Each one is a part of the UI
// (for example Projects or Leads). The meaning is shown under the heading, so anyone can tell what belongs there.
const CATEGORIES = [
  { name: 'Admin settings', meaning: 'Settings the admin changes for the whole portal: personal settings, invoice details and general settings.' },
  { name: 'Projects', meaning: 'Everything about a project, from creating it to approving, changing, cancelling and finishing it.' },
  { name: 'Website preview', meaning: 'The website preview of a project: setting it up, uploading the preview files and sharing it with the client.' },
  { name: 'Uploads & documents', meaning: 'File uploads from clients, upload links, upload status and documents kept on a client file.' },
  { name: 'Orders', meaning: 'Orders that a client or admin creates: product orders, custom projects and plan renewal.' },
  { name: 'Plans & packages', meaning: 'Plans and sales packages: creating, pricing, publishing and starting them for a client.' },
  { name: 'Payments & wallet', meaning: 'Money: marking invoices paid, wallet top-ups and approvals, bank accounts, installments and payment reminders.' },
  { name: 'Leads', meaning: 'Leads from the first contact to a client: creating, proposals, final messages and converting them.' },
  { name: 'Offers & reservations', meaning: 'Offers a customer reserves, extends or starts, and the offer targets of the sales team.' },
  { name: 'Customers & accounts', meaning: 'Client accounts: password reset, account status, roles and creating team or client accounts.' },
  { name: 'Profile & login', meaning: 'A user signing up, signing in, confirming a one-time code and keeping their own profile.' },
  { name: 'Support tickets', meaning: 'Support tickets a client opens and the replies to them.' },
  { name: 'Products & catalogue', meaning: 'Products and categories in the store, and showing or hiding them.' },
  { name: 'Website content', meaning: 'Pictures and text on the website: banners, advertisements, guest slides and welcome popups.' },
  { name: 'Messages & templates', meaning: 'Message templates and mail settings that decide what a message says and when it is sent.' },
  { name: 'Broadcast & WhatsApp', meaning: 'Sending broadcasts, the WhatsApp connection and queue, auto reply and reminder rules.' },
  { name: 'Trash & delete', meaning: 'Deleting records, moving them to Trash, restoring them and removing them for good.' },
  { name: 'Integrations & sync', meaning: 'Calls and sync jobs from other services. No person presses a button for these.' },
];
const NAMES = CATEGORIES.map(item => item.name);
const MEANING_BY_NAME = Object.fromEntries(CATEGORIES.map(item => [item.name, item.meaning]));
module.exports = { CATEGORIES, NAMES, MEANING_BY_NAME };
