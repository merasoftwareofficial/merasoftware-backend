// Guesses a new auto-reply lead's name and business name from the WhatsApp profile name
// (helpers/autoReplyJobs.js). Only a clear case fills a field; anything unclear stays empty,
// because a wrong guess is worse than none. The admin confirms or corrects it in Edit Lead.

// Whole words that clearly mark a business. Compared lowercase, one word at a time. Words people also
// use about themselves (official, digital, tech, media, mobile, group, co, service) are left out:
// a missed business name stays empty, which is better than a person's name in the business field.
const BUSINESS_WORDS = new Set([
  "store", "stores", "shop", "shoppe", "traders", "trading", "enterprises", "enterprise", "electronics",
  "solutions", "pvt", "ltd", "llp", "inc", "company", "services", "agency",
  "mart", "studios", "industries", "furniture", "furnitures", "mobiles",
  "clinic", "hospital", "academy", "institute", "classes", "boutique", "salon", "jewellers", "jewellery",
  "garments", "textiles", "motors", "automobiles", "hardware", "sanitary", "paints", "builders",
  "constructions", "construction", "properties", "realty", "infotech", "technologies",
  "consultancy", "consultants", "travels", "tours", "hotel", "restaurant",
  "cafe", "dhaba", "sweets", "bakery", "foods", "dairy", "pharmacy", "medicos", "chemist",
  "opticals", "computers", "telecom", "printers", "interiors", "photography", "gym", "fitness",
  "school", "overseas", "immigration", "exports", "imports", "wholesale", "distributors", "suppliers",
]);

// Greetings, blessings and words that are never a name.
const NOT_A_NAME = new Set([
  "hi", "hello", "hey", "hii", "ok", "okay", "user", "unknown", "me", "myself", "whatsapp", "busy",
  "available", "jai mata di", "jai shree ram", "jai shri ram", "jai siya ram", "radhe radhe",
  "radhe krishna", "radhe radhe ji", "har har mahadev", "mahadev", "bholenath", "om", "om namah shivay",
  "om namah shivaya", "waheguru", "waheguru ji", "satnam waheguru", "ram ram", "sai ram", "jai hind",
  "allah", "bismillah", "ganpati bappa morya", "jai bajrang bali", "jai shree krishna", "jai mahakal",
  "good morning", "good night", "good evening", "good afternoon", "good day", "thank you", "thanks",
  "shree ganesh", "shri ganesh", "shree ganesh ji", "shri ganesh ji", "jai ganesh", "jai shri krishna",
  "jai jinendra", "jai bhim", "jai mata ki", "jai gurudev", "jai shri shyam", "jai shree shyam",
  "jai baba ki", "sat sri akal", "always smile", "keep smiling", "no name", "new number",
]);

// Separators people put between their name and their business: "Rahul | Sharma Electronics",
// and a dash with no spaces between two words ("Amit-AK Mobiles"). A split is used only when
// one side is a business name (guessFromProfileName below), so "Ram-Lal" is not split.
const SEPARATOR = /\s*(?:\||\/|,|@|\s-\s|\s–\s|\s—\s|\(|\)|\[|\]|(?<=\p{L})-(?=\p{L}))\s*/u;

const clean = (text) => String(text || "")
  .normalize("NFKC")
  .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, " ")
  .replace(/[~*_"'`.!#:;<>{}=+^]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const words = (text) => text.toLowerCase().split(" ").filter(Boolean);
const isBusiness = (text) => words(text).some((word) => BUSINESS_WORDS.has(word));
// A person's name: letters only, one to four words, and not a greeting or a blessing.
const isPersonName = (text) => /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+){0,3}$/u.test(text)
  && text.replace(/\s/g, "").length >= 2
  && !NOT_A_NAME.has(text.toLowerCase());
const isBusinessName = (text) => isBusiness(text) && /\p{L}/u.test(text) && text.length <= 60;

/** { name, businessName }: each "" unless the profile name shows it clearly. */
function guessFromProfileName(profileName) {
  const whole = clean(profileName);
  const empty = { name: "", businessName: "" };
  if (!whole || NOT_A_NAME.has(whole.toLowerCase())) return empty;

  const parts = whole.split(SEPARATOR).map(clean).filter(Boolean);
  if (parts.length === 2) {
    const [first, second] = parts;
    if (isBusinessName(second) && !isBusiness(first) && isPersonName(first)) return { name: first, businessName: second };
    if (isBusinessName(first) && !isBusiness(second) && isPersonName(second)) return { name: second, businessName: first };
  }
  if (isBusinessName(whole)) return { name: "", businessName: whole };
  if (parts.length === 1 && isPersonName(whole)) return { name: whole, businessName: "" };
  return empty;
}

module.exports = { guessFromProfileName };
