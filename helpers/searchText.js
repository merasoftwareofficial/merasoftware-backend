// Admin search (controller/lead/globalSearch.js). A phone number matches whatever spaces, dashes or
// brackets it was saved or typed with: "98765 43210", "98765-43210" and "9876543210" are one number.
// An Indian code typed in front (+91, 0091, 91 on a full number, or a leading 0) is dropped, so
// "+91 98765 43210" also finds a number saved as "98765 43210".
// Keep in step with frontend/src/helpers/searchText.js, which the Leads and Clients lists use.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PHONE_QUERY = /^[\d\s+\-().]+$/;
const PHONE_GAP = "[\\s\\-().]*";

/** The digits of a phone search, without an Indian country code or trunk 0 in front. */
function searchDigits(query) {
  const digits = query.replace(/\D/g, "");
  if (/^\s*(\+|00)91/.test(query)) return digits.replace(/^(00)?91/, "");
  if (/^91[6-9]\d{9}$/.test(digits)) return digits.slice(2);
  if (/^0[6-9]\d{9}$/.test(digits)) return digits.slice(1);
  return digits;
}

/** { text, phone }: `text` for names and emails; `phone` for phone numbers. */
function searchPatterns(query) {
  const text = new RegExp(escapeRegex(query), "i");
  const digits = PHONE_QUERY.test(query) ? searchDigits(query) : "";
  const phone = digits.length >= 3 ? new RegExp(digits.split("").join(PHONE_GAP)) : text;
  return { text, phone };
}

module.exports = { escapeRegex, searchDigits, searchPatterns };
