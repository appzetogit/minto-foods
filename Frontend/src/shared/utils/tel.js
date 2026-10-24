/**
 * A `tel:` link that always dials an Indian number with +91.
 *
 * Numbers reach the panels as "9876543210", "09876543210", "919876543210" or
 * "+91 98765 43210"; some phones dialled the bare 10 digits as a local call
 * to the wrong circle. Short service numbers (100, 112) are left as they are.
 */
export function telHref(phone) {
  const raw = String(phone ?? "").trim();
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return "tel:+91" + digits;
  return "tel:" + raw.replace(/[^\d+]/g, "");
}
