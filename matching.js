// Vergelijkingsregels voor telefonische verificatie.
// Doel: oudere bellers niet afwijzen op een verkeerd verstane naam of postcode,
// zonder dat iemand met alleen een ordernummer andermans order kan opvragen.

import { doubleMetaphone } from "double-metaphone";

// Levenshtein-afstand (aantal tekens toevoegen/weghalen/vervangen)
export function editDistance(a = "", b = "") {
  a = String(a);
  b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const lettersOnly = (s = "") =>
  String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

// Een naam uit Shopify die niet als naam bruikbaar is (e-mailadres, te kort, geen klinker)
export function usableName(name = "") {
  const s = String(name).trim();
  if (!s || s.includes("@")) return false;
  const l = lettersOnly(s);
  return l.length >= 2 && /[aeiouy]/.test(l);
}

// Delen van een (achter)naam: "Denton-Beaumont" -> ["denton", "beaumont", "dentonbeaumont"]
function nameParts(name = "") {
  const parts = String(name)
    .split(/[\s\-']+/)
    .map(lettersOnly)
    .filter((p) => p.length >= 2);
  const joined = lettersOnly(name);
  return [...new Set([...parts, joined].filter(Boolean))];
}

function codes(word) {
  const [p, s] = doubleMetaphone(word);
  return [...new Set([p, s].filter(Boolean))];
}

// Klinkt de verstane achternaam als (een deel van) de naam op de order?
export function surnameMatches(heard, candidates = []) {
  const heardParts = nameParts(heard);
  if (!heardParts.length) return false;
  for (const candidate of candidates) {
    if (!usableName(candidate)) continue;
    for (const c of nameParts(candidate)) {
      for (const h of heardParts) {
        if (h === c) return true;
        // Bijna gelijk geschreven (Francis/Frances, Pretwell/Fretwell)
        if (Math.min(h.length, c.length) >= 5 && editDistance(h, c) <= 1) return true;
        // Klinkt hetzelfde (baymont/Beaumont)
        const hc = codes(h);
        const cc = codes(c);
        if (hc.some((x) => cc.includes(x))) return true;
        // Klinkt bijna hetzelfde, alleen bij langere codes (PRTL/FRTL), niet bij JNS/JMS
        if (hc.some((x) => cc.some((y) => Math.min(x.length, y.length) >= 4 && editDistance(x, y) <= 1))) return true;
      }
    }
  }
  return false;
}

// Postcode: spaties negeren, O/0 en I/1 gelijk, maximaal één afwijkend teken
export function normalizePostcode(pc = "") {
  return String(pc).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
}

export function postcodeMatches(heard, candidates = []) {
  const h = normalizePostcode(heard);
  if (h.length < 5) return false;
  return candidates.some((c) => {
    const n = normalizePostcode(c);
    if (n.length < 5) return false;
    if (h === n) return true;
    // Eén afwijkend teken, maar het eerste deel (de stad/regio-letters) moet kloppen
    return h[0] === n[0] && editDistance(h, n) <= 1;
  });
}

// Telefoon: laatste 9 cijfers vergelijken (07…, 7951…, +44… komen dan overeen)
export function phoneKey(phone = "") {
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

export function phoneMatches(caller, candidates = []) {
  const k = phoneKey(caller);
  return Boolean(k) && candidates.some((c) => phoneKey(c) === k);
}

// Trackingnummer van het label: alleen letters/cijfers, hoofdletters; gelijk of de één bevat de ander
export function normalizeTracking(t = "") {
  return String(t).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function trackingMatches(heard, candidates = []) {
  const h = normalizeTracking(heard);
  if (h.length < 8) return false;
  return candidates.some((c) => {
    const n = normalizeTracking(c);
    if (n.length < 8) return false;
    return h === n || n.includes(h) || h.includes(n) || (h.length >= 10 && editDistance(h, n) <= 1);
  });
}

// Alle namen, postcodes en telefoonnummers die bij een order horen
export function orderKeys(order = {}) {
  const ship = order.shippingAddress || {};
  const bill = order.billingAddress || {};
  return {
    names: [ship.lastName, bill.lastName, ship.name, bill.name].filter(Boolean),
    postcodes: [ship.zip, bill.zip].filter(Boolean),
    phones: [order.phone, ship.phone, bill.phone].filter(Boolean),
    tracking: (order.fulfillments || []).flatMap((f) => (f.trackingInfo || []).map((t) => t.number)).filter(Boolean),
    email: order.email || null,
  };
}

// Verificatie bij een bekend ordernummer: achternaam, of postcode, of e-mail, of telefoon van de beller
export function verifyOrder(order, { last_name, postcode, email } = {}, fromNumber) {
  const k = orderKeys(order);
  if (last_name && surnameMatches(last_name, k.names)) return "achternaam";
  if (postcode && postcodeMatches(postcode, k.postcodes)) return "postcode";
  if (email && k.email && String(email).trim().toLowerCase() === k.email.toLowerCase()) return "email";
  if (fromNumber && phoneMatches(fromNumber, k.phones)) return "telefoon";
  return null;
}

// Zoeken zonder ordernummer: altijd twee sleutels, nooit alleen de beller-ID
export function matchWithoutNumber(order, { last_name, postcode, tracking_number } = {}, fromNumber) {
  const k = orderKeys(order);
  const nameOk = last_name ? surnameMatches(last_name, k.names) : false;
  const nameUnusable = !k.names.some(usableName);
  const pcOk = postcode ? postcodeMatches(postcode, k.postcodes) : false;
  const trackOk = tracking_number ? trackingMatches(tracking_number, k.tracking) : false;
  const phoneOk = fromNumber ? phoneMatches(fromNumber, k.phones) : false;

  if (trackOk && (nameOk || pcOk || phoneOk || nameUnusable)) return "tracking";
  if (pcOk && (nameOk || phoneOk || nameUnusable)) return "achternaam_postcode";
  if (phoneOk && nameOk) return "telefoon_achternaam";
  return null;
}
