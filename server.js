// Myvio order-agent middleware
// Retell (custom function) -> deze server -> Shopify Admin API + 17TRACK
// Retell (webhook na het gesprek) -> deze server -> ELLA-ACTIE-mail naar het team
// Eén server bedient meerdere stores: de store wordt bepaald via het Retell agent_id.

import express from "express";
import Retell from "retell-sdk";
import nodemailer from "nodemailer";
import { verifyOrder, matchWithoutNumber, postcodeMatches } from "./matching.js";

const app = express();
// De ruwe tekst van het verzoek bewaren: Retell ondertekent precies die tekst
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));

const {
  PORT = 3000,
  RETELL_API_KEY,
  TRACK17_API_KEY,
  STORES = "",
  SHOPIFY_API_VERSION = "2026-07", // check de nieuwste stabiele versie in de Shopify-docs
  MAX_VERIFY_ATTEMPTS = "2", // mislukte verificaties per gesprek
  SEARCH_ORDER_LIMIT = "250", // zoeken zonder ordernummer: in de laatste zoveel orders
} = process.env;

// ---------- Store-configuratie ----------
const stores = Object.fromEntries(
  STORES.split(",").filter(Boolean).map((line) => {
    const [agentId, domain, token, deliveryText] = line.split("|").map((s) => s.trim());
    return [agentId, { domain, token, deliveryText }];
  })
);

// ---------- Beveiliging: alleen echte Retell-verzoeken ----------
function verifyRetell(req, res, next) {
  const signature = req.headers["x-retell-signature"];
  const ok =
    signature &&
    ((req.rawBody && Retell.verify(req.rawBody, RETELL_API_KEY, signature)) ||
      Retell.verify(JSON.stringify(req.body), RETELL_API_KEY, signature));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Max 2 mislukte verificaties per gesprek (tegen uitproberen van ordernummers)
const failedAttempts = new Map();
function tooManyAttempts(callId) {
  return (failedAttempts.get(callId) || 0) >= Number(MAX_VERIFY_ATTEMPTS);
}
function registerFail(callId) {
  failedAttempts.set(callId, (failedAttempts.get(callId) || 0) + 1);
  setTimeout(() => failedAttempts.delete(callId), 60 * 60 * 1000);
}

// Gespreksgeheugen: welke order is in dit gesprek geverifieerd (voor de portal-mail en de ELLA-ACTIE-mail)
const verifiedOrders = new Map(); // call_id -> { name, email, via }
function rememberOrder(callId, order, via) {
  if (!callId) return;
  verifiedOrders.set(callId, { name: order.name, email: order.email || null, via });
  setTimeout(() => verifiedOrders.delete(callId), 2 * 60 * 60 * 1000);
}
const sameOrder = (a, b) => String(a || "").replace(/[^0-9a-z]/gi, "") === String(b || "").replace(/[^0-9a-z]/gi, "");
function rememberedOrder(callId, orderNumber) {
  const m = verifiedOrders.get(callId);
  if (!m) return null;
  return !orderNumber || sameOrder(m.name, orderNumber) ? m : null;
}

// Retell stuurt { call, name, args }; bij "args only" alleen de args
function parse(req) {
  const call = req.body.call || {};
  const args = req.body.args || req.body;
  const store = stores[call.agent_id] || Object.values(stores)[0];
  return { call, args, store };
}

// ---------- Shopify-token ----------
// Staat er in STORES "auto" in plaats van een shpat-token, dan haalt de server zelf
// een token op met SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (client_credentials).
// Zo'n token is 24 uur geldig; we vernieuwen ruim op tijd en bij een 401.
const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
const tokenCache = new Map(); // domein -> { token, expiresAt }
const tokenRequests = new Map(); // domein -> lopend verzoek (voorkomt dubbele aanvragen)

const usesAutoToken = (store) => !store.token || store.token === "auto";

async function fetchNewToken(store) {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("SHOPIFY_CLIENT_ID of SHOPIFY_CLIENT_SECRET ontbreekt");
  }
  const res = await fetch(`https://${store.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Shopify-token aanvragen mislukt (HTTP ${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new Error("Shopify gaf geen access_token terug");
  const expiresIn = Number(json.expires_in) || 24 * 60 * 60;
  tokenCache.set(store.domain, { token: json.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  console.log(`Shopify-token vernieuwd voor ${store.domain} (geldig ${Math.round(expiresIn / 3600)} uur)`);
  return json.access_token;
}

async function getToken(store, { force = false } = {}) {
  if (!usesAutoToken(store)) return store.token;
  const cached = tokenCache.get(store.domain);
  if (!force && cached && cached.expiresAt - Date.now() > 10 * 60 * 1000) return cached.token;
  if (!tokenRequests.has(store.domain)) {
    tokenRequests.set(store.domain, fetchNewToken(store).finally(() => tokenRequests.delete(store.domain)));
  }
  return tokenRequests.get(store.domain);
}

// Ruim op tijd vernieuwen, zodat een gesprek nooit op een verlopen token hoeft te wachten
async function refreshTokensIfNeeded() {
  for (const store of Object.values(stores)) {
    if (!usesAutoToken(store)) continue;
    const cached = tokenCache.get(store.domain);
    if (!cached || cached.expiresAt - Date.now() < 60 * 60 * 1000) {
      try {
        await getToken(store, { force: true });
      } catch (e) {
        console.error("Shopify-token", store.domain, e.message);
      }
    }
  }
}
refreshTokensIfNeeded();
setInterval(refreshTokensIfNeeded, 15 * 60 * 1000);

// ---------- Shopify ----------
async function shopify(store, query, variables, retried = false) {
  const token = await getToken(store);
  const res = await fetch(
    `https://${store.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(4000),
    }
  );
  // Verlopen of ingetrokken token: één keer een nieuw token halen en opnieuw proberen
  if (res.status === 401 && usesAutoToken(store) && !retried) {
    await getToken(store, { force: true });
    return shopify(store, query, variables, true);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Namen op de order vallen onder 'protected customer data'. Geeft Shopify daar geen toegang
// toe, dan valt de server terug op de query zonder namen (verificatie op achternaam staat dan uit).
let nameAccess = true;
const names = (on) => (on ? "lastName name" : "");

const ORDER_QUERY = (on) => `
query ($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      name
      createdAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      email
      phone
      shippingAddress { zip address1 city countryCodeV2 phone ${names(on)} }
      billingAddress { zip phone ${names(on)} }
      lineItems(first: 20) { nodes { title variantTitle quantity } }
      fulfillments(first: 5) {
        displayStatus
        createdAt
        estimatedDeliveryAt
        trackingInfo(first: 2) { number company url }
      }
    }
  }
}`;

// Lichte query om recente orders te doorzoeken (zonder ordernummer)
const SEARCH_QUERY = (on) => `
query ($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name
      phone
      shippingAddress { zip phone ${names(on)} }
      billingAddress { zip phone ${names(on)} }
      fulfillments(first: 3) { trackingInfo(first: 2) { number } }
    }
  }
}`;

async function shopifyOrders(store, build, variables) {
  try {
    return await shopify(store, build(nameAccess), variables);
  } catch (e) {
    if (nameAccess && /access|denied|approved|permission|protected/i.test(e.message)) {
      nameAccess = false;
      console.warn("Shopify geeft geen toegang tot namen op orders: verificatie op achternaam staat uit. Zet in de Shopify-app 'protected customer data' aan voor naam.");
      return await shopify(store, build(false), variables);
    }
    throw e;
  }
}

const norm = (s = "") => String(s).toLowerCase().replace(/\s+/g, "");

async function findOrder(store, orderNumber) {
  const name = String(orderNumber || "").replace(/[^0-9a-z]/gi, "");
  if (!name) return null;
  const data = await shopifyOrders(store, ORDER_QUERY, { q: `name:#${name}` });
  return data.orders.nodes[0] || null;
}

// Zoeken zonder ordernummer: nieuwste orders eerst, twee sleutels nodig
async function searchOrder(store, args, fromNumber) {
  let after = null;
  let seen = 0;
  while (seen < Number(SEARCH_ORDER_LIMIT)) {
    const data = await shopifyOrders(store, SEARCH_QUERY, { first: 50, after });
    for (const o of data.orders.nodes) {
      const via = matchWithoutNumber(o, args, fromNumber);
      if (via) return { order: await findOrder(store, o.name), via };
    }
    seen += data.orders.nodes.length;
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return { order: null, via: null };
}

// Order zoeken én verifiëren in één stap
async function findVerifiedOrder(store, args, fromNumber) {
  if (args.order_number) {
    const order = await findOrder(store, args.order_number);
    const via = order ? verifyOrder(order, args, fromNumber) : null;
    return { order: via ? order : null, via };
  }
  if (args.last_name || args.postcode || args.tracking_number) return searchOrder(store, args, fromNumber);
  return { order: null, via: null };
}

function failInstruction(callId) {
  if (tooManyAttempts(callId)) {
    return "Niet opnieuw proberen. Vraag naam en postcode voor de samenvatting en zet het verzoek door naar het team.";
  }
  return "Vraag één keer de postcode en probeer opnieuw (ordernummer, achternaam en postcode). Zeg niet welk gegeven niet klopt.";
}

// ---------- 17TRACK ----------
async function trackingStatus(number) {
  if (!TRACK17_API_KEY || !number) return null;
  const headers = { "Content-Type": "application/json", "17token": TRACK17_API_KEY };
  const body = JSON.stringify([{ number }]);
  try {
    // Registreren is nodig voordat 17TRACK een nummer volgt (dubbel registreren is onschuldig)
    await fetch("https://api.17track.net/track/v2.2/register", { method: "POST", headers, body, signal: AbortSignal.timeout(2500) });
    const res = await fetch("https://api.17track.net/track/v2.2/gettrackinfo", { method: "POST", headers, body, signal: AbortSignal.timeout(2500) });
    const json = await res.json();
    const info = json?.data?.accepted?.[0]?.track_info;
    if (!info) return null;
    return {
      status: info.latest_status?.status || null,          // bv. InTransit, Delivered
      laatste_gebeurtenis: info.latest_event?.description || null,
      laatste_update: info.latest_event?.time_iso || null,
      verwachte_bezorging_van: info.time_metrics?.estimated_delivery_date?.from || null,
      verwachte_bezorging_tot: info.time_metrics?.estimated_delivery_date?.to || null,
    };
  } catch {
    return null; // tracking mag het gesprek nooit blokkeren
  }
}

// ---------- Function 1: lookup_order ----------
// Met ordernummer: + achternaam, postcode of e-mail. Zonder ordernummer: achternaam + postcode,
// of trackingnummer + achternaam/postcode. Het telefoonnummer van de beller telt mee als extra sleutel.
app.post("/retell/lookup_order", verifyRetell, async (req, res) => {
  const { call, args, store } = parse(req);
  try {
    if (tooManyAttempts(call.call_id)) {
      return res.json({ resultaat: "te_veel_pogingen", instructie: failInstruction(call.call_id) });
    }
    if (!args.order_number && !args.last_name && !args.postcode && !args.tracking_number) {
      return res.json({ resultaat: "meer_gegevens_nodig", instructie: "Vraag het ordernummer en de achternaam, of de achternaam en postcode, of het trackingnummer van het pakketlabel." });
    }
    const { order, via } = await findVerifiedOrder(store, args, call.from_number);
    if (!order) {
      registerFail(call.call_id);
      console.log(`lookup_order niet geverifieerd (${args.order_number ? "met" : "zonder"} ordernummer; naam ${args.last_name ? "ja" : "nee"}, postcode ${args.postcode ? "ja" : "nee"}, tracking ${args.tracking_number ? "ja" : "nee"})`);
      // Bewust geen onderscheid tussen 'bestaat niet' en 'klopt niet' (privacy)
      return res.json({ resultaat: tooManyAttempts(call.call_id) ? "te_veel_pogingen" : "niet_geverifieerd", instructie: failInstruction(call.call_id) });
    }
    rememberOrder(call.call_id, order, via);
    console.log(`lookup_order gevonden: ${order.name} (via ${via})`);

    const f = order.fulfillments[0];
    const tracking = f?.trackingInfo?.[0];
    const live = await trackingStatus(tracking?.number);

    res.json({
      resultaat: "gevonden",
      order: order.name,
      gevonden_via: via,
      besteld_op: order.createdAt,
      geannuleerd: Boolean(order.cancelledAt),
      betaalstatus: order.displayFinancialStatus,
      fulfilmentstatus: order.displayFulfillmentStatus,
      producten: order.lineItems.nodes.map((l) => `${l.quantity}x ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`),
      verzonden_op: f?.createdAt || null,
      vervoerder: tracking?.company || null,
      trackingnummer_beschikbaar: Boolean(tracking?.number),
      trackinglink: tracking?.url || null,
      trackingstatus: live,
      verwachte_bezorging_shopify: f?.estimatedDeliveryAt || null,
      standaard_levertijd: store.deliveryText,
      // Het adres zelf gaat NIET terug naar de agent
    });
  } catch (e) {
    console.error("lookup_order", e.message);
    res.json({ resultaat: "fout", instructie: "Excuseer je. Vraag naam en postcode voor de samenvatting en zet het verzoek door naar het team." });
  }
});

// ---------- Function 2: verify_address ----------
// Klant noemt zelf postcode + huisnummer; wij zeggen alleen of het klopt.
app.post("/retell/verify_address", verifyRetell, async (req, res) => {
  const { call, args, store } = parse(req);
  try {
    const remembered = rememberedOrder(call.call_id, args.order_number);
    let order;
    if (remembered) {
      order = await findOrder(store, remembered.name);
    } else {
      if (tooManyAttempts(call.call_id)) return res.json({ resultaat: "te_veel_pogingen" });
      ({ order } = await findVerifiedOrder(store, args, call.from_number));
      if (!order) {
        registerFail(call.call_id);
        return res.json({ resultaat: "niet_geverifieerd" });
      }
    }
    const a = order.shippingAddress || {};
    const zipOk = postcodeMatches(args.postcode, [a.zip]);
    const houseOk = args.house_number ? norm(a.address1).includes(norm(args.house_number)) : true;
    res.json({ resultaat: zipOk && houseOk ? "adres_klopt" : "adres_wijkt_af" });
  } catch (e) {
    console.error("verify_address", e.message);
    res.json({ resultaat: "fout" });
  }
});

// ---------- Function 3: send_cancel_link_email ----------
// Mailt de opzeglink naar het e-mailadres dat OP DE ORDER staat (nooit naar een
// adres dat de beller noemt). Verstuurt via Zoho Mail (SMTP, app-wachtwoord).
const {
  ZOHO_SMTP_HOST = "smtp.zoho.eu",
  ZOHO_SMTP_USER,
  ZOHO_SMTP_PASS,
  MAIL_BRAND = "Elvéra",
  CANCEL_LINK_URL,
} = process.env;

const mailer = nodemailer.createTransport({
  host: ZOHO_SMTP_HOST,
  port: 465,
  secure: true,
  auth: { user: ZOHO_SMTP_USER, pass: ZOHO_SMTP_PASS },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 8000,
});

// Max 2 opzegmails per gesprek
const mailsSent = new Map();
function tooManyMails(callId) {
  return (mailsSent.get(callId) || 0) >= 2;
}
function registerMail(callId) {
  mailsSent.set(callId, (mailsSent.get(callId) || 0) + 1);
  setTimeout(() => mailsSent.delete(callId), 60 * 60 * 1000);
}

function cancelMail(to) {
  const text = [
    "Hello,",
    "",
    `Thank you for calling ${MAIL_BRAND}. As discussed on the phone, here is the link to your customer portal:`,
    "",
    CANCEL_LINK_URL,
    "",
    "Open the link and enter the email address you ordered with. In your customer portal you'll find the options for your subscription,",
    "and you can cancel it there.",
    "Please make any change at least 24 hours before your next payment date. You'll see that date in the portal.",
    "",
    "If anything doesn't work, just reply to this email and our team will help you.",
    "",
    "Kind regards,",
    `The ${MAIL_BRAND} team`,
  ].join("\n");

  const html = `<p>Hello,</p>
<p>Thank you for calling ${MAIL_BRAND}. As discussed on the phone, here is the link to your customer portal:</p>
<p><a href="${CANCEL_LINK_URL}">Open my customer portal</a></p>
<p>Open the link and enter the email address you ordered with. In your customer portal you'll find the options for your subscription,
and you can cancel it there.<br>
Please make any change at least 24 hours before your next payment date. You'll see that date in the portal.</p>
<p>If anything doesn't work, just reply to this email and our team will help you.</p>
<p>Kind regards,<br>The ${MAIL_BRAND} team</p>`;

  return {
    from: `"${MAIL_BRAND}" <${ZOHO_SMTP_USER}>`,
    replyTo: ZOHO_SMTP_USER,
    to,
    subject: `Your ${MAIL_BRAND} customer portal`,
    text,
    html,
  };
}

app.post("/retell/send_cancel_link_email", verifyRetell, async (req, res) => {
  const { call, args, store } = parse(req);
  try {
    if (!ZOHO_SMTP_USER || !ZOHO_SMTP_PASS || !CANCEL_LINK_URL) {
      console.error("send_cancel_link_email: ZOHO_SMTP_USER, ZOHO_SMTP_PASS of CANCEL_LINK_URL ontbreekt");
      return res.json({ resultaat: "fout", instructie: "Excuseer je. Leg niets uit en zet het verzoek door naar het team (samenvatting + doorzetten)." });
    }
    if (tooManyMails(call.call_id)) {
      return res.json({ resultaat: "al_verstuurd", instructie: "De mail is al twee keer verstuurd. Vraag de klant in spam of ongewenst te kijken. Leg niets uit en zet het verzoek door naar het team (samenvatting + doorzetten)." });
    }
    // Eerst het gespreksgeheugen: is deze order in dit gesprek al geverifieerd via lookup_order?
    const remembered = rememberedOrder(call.call_id, args.order_number);
    let order = null;
    if (remembered) {
      order = { name: remembered.name, email: remembered.email };
    } else {
      if (tooManyAttempts(call.call_id)) {
        return res.json({ resultaat: "te_veel_pogingen", instructie: "Leg niets uit en zet het verzoek door naar het team (samenvatting + doorzetten)." });
      }
      ({ order } = await findVerifiedOrder(store, args, call.from_number));
      if (!order) {
        registerFail(call.call_id);
        return res.json({ resultaat: "niet_geverifieerd", instructie: "Leg niets uit en zet het verzoek door naar het team (samenvatting + doorzetten)." });
      }
      rememberOrder(call.call_id, order, "portal_mail");
    }
    if (!order.email) {
      return res.json({ resultaat: "geen_email", instructie: "Er staat geen e-mailadres op de order. Leg niets uit en zet het verzoek door naar het team (samenvatting + doorzetten)." });
    }

    await mailer.sendMail(cancelMail(order.email));
    registerMail(call.call_id);
    console.log(`send_cancel_link_email verstuurd voor order ${order.name}`);
    // Het e-mailadres zelf gaat NIET terug naar de agent
    res.json({ resultaat: "verstuurd" });
  } catch (e) {
    console.error("send_cancel_link_email", e.message);
    res.json({ resultaat: "fout", instructie: "Excuseer je, de mail kon niet worden verstuurd. Leg niets uit en zet het verzoek door naar het team (samenvatting + doorzetten)." });
  }
});

// ---------- ELLA-ACTIE: na het gesprek een mail naar het team ----------
// Retell stuurt na elk gesprek het event "call_analyzed" met de post-call-analyse.
// Heeft het gesprek een actie nodig, dan gaat er een mail naar ELLA_ACTIE_TO.
const { ELLA_ACTIE_TO, ELLA_ACTIE_TRANSCRIPT = "false" } = process.env;

const handledCalls = new Map(); // call_id -> tijd (Retell kan een webhook dubbel sturen)
const yes = (v) => v === true || /^(true|yes|ja|y|1)$/i.test(String(v ?? "").trim());

const TODO = {
  opzeggen: "Abonnement opzeggen in Loop én de openstaande verlenging in Shopify tegenhouden of annuleren. Klant per mail bevestigen.",
  refund: "Refundverzoek beoordelen en de klant per mail antwoorden.",
  niet_besteld: "Nagaan of de klant bewust een abonnement had. Opzeggen, openstaande verlenging tegenhouden en refund beoordelen. Klant per mail antwoorden.",
  pakket: "Pakket nagaan (vertraagd, kwijt of beschadigd) en de klant per mail antwoorden.",
  adres: "Adres aanpassen als de order nog niet verzonden is, en de klant per mail antwoorden.",
  mens_gevraagd: "De klant wilde een medewerker. Per mail contact opnemen.",
};

// Rode vlaggen (wens Elvéra, 8-11-2026). Retell vult "rode_vlaggen" met een of meer van deze sleutels.
const RODE_VLAGGEN = {
  bank: { label: "Bank of kaart (bank bellen, kaart blokkeren)", urgent: true },
  dispute: { label: "Dispute, chargeback of PayPal-claim", urgent: true },
  fraude: { label: "Fraude, scam, oplichting of diefstal", urgent: true },
  toezicht_juridisch: { label: "Toezichthouder of jurist (Trading Standards, solicitor, lawyer, police, Citizens Advice, ombudsman, ASA)", urgent: true },
  herhaling: { label: "Herhaling (al opgezegd, vaker gevraagd, niemand reageert)", urgent: true },
  dwingend: { label: "Dwingend (cancel now, stop charging me)", urgent: false },
  reputatie: { label: "Reputatie (Trustpilot, review, Facebook, report you)", urgent: false },
  privacy: { label: "Privacy (delete my data, GDPR) – wettelijke termijn: binnen één maand reageren", urgent: false },
  kwetsbaar: { label: "Kwetsbare klant (overlijden, dementie, verward, kan het niet betalen)", urgent: false },
  toon: { label: "Toon (schelden, stemverheffing, huilen, steeds onderbreken, ophangen)", urgent: false },
};

function parseFlags(d = {}) {
  const raw = Array.isArray(d.rode_vlaggen) ? d.rode_vlaggen.join(",") : String(d.rode_vlaggen || "");
  const keys = raw.toLowerCase().split(/[^a-z_]+/).filter((k) => RODE_VLAGGEN[k]);
  if (yes(d.chargeback_signaal) && !keys.some((k) => RODE_VLAGGEN[k].urgent)) keys.push("dispute");
  return [...new Set(keys)];
}

// Urgent bij een financieel/juridisch signaal of herhaling; toon versterkt elke andere rode vlag
function isUrgent(flags) {
  return flags.some((k) => RODE_VLAGGEN[k].urgent) || (flags.includes("toon") && flags.length > 1);
}

function ellaActieMail(call) {
  const a = call.call_analysis || {};
  const d = a.custom_analysis_data || {};
  const intent = String(d.intent || "").trim().toLowerCase() || "onbekend";
  const flags = parseFlags(d);
  const chargeback = isUrgent(flags);
  const remembered = verifiedOrders.get(call.call_id);
  const orderNr = remembered?.name || (d.ordernummer ? `#${String(d.ordernummer).replace(/^#/, "")}` : null);
  const linkSent = (mailsSent.get(call.call_id) || 0) > 0 || yes(d.portal_link_verstuurd);
  const start = call.start_timestamp ? new Date(call.start_timestamp) : null;
  const duur = call.start_timestamp && call.end_timestamp ? Math.round((call.end_timestamp - call.start_timestamp) / 1000) : null;

  const subject = `${chargeback ? "URGENT | " : flags.length ? "RODE VLAG | " : ""}ELLA-ACTIE | ${intent} | ${orderNr || "geen ordernummer"}`;
  const lines = [
    chargeback ? "URGENT: Ella heeft gezegd dat het team binnen één werkdag mailt. Met voorrang oppakken." : null,
    flags.length ? `Rode vlaggen: ${flags.map((k) => RODE_VLAGGEN[k].label).join("; ")}` : null,
    flags.includes("kwetsbaar") ? "Let op: mogelijk kwetsbare klant. Extra zorgvuldig en coulant reageren." : null,
    flags.includes("privacy") ? "Let op: privacyverzoek (AVG/UK GDPR). Binnen één maand afhandelen en bevestigen." : null,
    `Te doen: ${chargeback ? "Met voorrang. " : ""}${TODO[intent] || "Gesprek beoordelen en de klant per mail antwoorden."}`,
    "",
    `Intent: ${intent}`,
    `Ordernummer: ${orderNr || "onbekend"}`,
    `Geverifieerd: ${remembered ? `ja (via ${remembered.via})` : yes(d.verificatie_geslaagd) ? "ja" : "nee"}`,
    remembered?.email ? `E-mail klant (van de order): ${remembered.email}` : null,
    d.achternaam ? `Achternaam (zoals verstaan): ${d.achternaam}` : null,
    d.postcode ? `Postcode (zoals verstaan): ${d.postcode}` : null,
    d.tracking_nummer ? `Trackingnummer (zoals verstaan): ${d.tracking_nummer}` : null,
    `Telefoon beller: ${call.from_number || "onbekend"}`,
    `Portal-link gemaild: ${linkSent ? "ja" : "nee"}`,
    `Opgelost in het gesprek: ${yes(d.opgelost_in_gesprek) ? "ja" : "nee"}`,
    "",
    `Samenvatting: ${d.samenvatting || a.call_summary || "geen samenvatting"}`,
    "",
    start ? `Gesprek: ${start.toLocaleString("en-GB", { timeZone: "Europe/London" })} (UK-tijd)${duur ? `, ${Math.floor(duur / 60)}:${String(duur % 60).padStart(2, "0")} min` : ""}` : null,
    call.recording_url ? `Opname: ${call.recording_url}` : null,
    `Retell call ID: ${call.call_id}`,
    yes(ELLA_ACTIE_TRANSCRIPT) && call.transcript ? `\nTranscript:\n${call.transcript}` : null,
  ].filter((l) => l !== null);

  return {
    from: `"Ella – ${MAIL_BRAND}" <${ZOHO_SMTP_USER}>`,
    to: ELLA_ACTIE_TO,
    replyTo: remembered?.email || undefined, // antwoorden gaat dan direct naar de klant
    subject,
    text: lines.join("\n"),
  };
}

function needsAction(call) {
  const d = call.call_analysis?.custom_analysis_data || {};
  const intent = String(d.intent || "").trim().toLowerCase();
  return parseFlags(d).length > 0 || yes(d.doorgezet_naar_team) || (intent && intent !== "overig");
}

app.post("/retell/webhook", verifyRetell, async (req, res) => {
  const { event, call } = req.body || {};
  if (event !== "call_analyzed" || !call?.call_id) return res.status(204).end();
  if (handledCalls.has(call.call_id)) return res.status(204).end();

  if (!needsAction(call)) {
    console.log(`webhook ${call.call_id}: geen actie nodig`);
    return res.status(204).end();
  }
  if (!ELLA_ACTIE_TO || !ZOHO_SMTP_USER || !ZOHO_SMTP_PASS) {
    console.error("ELLA-ACTIE: ELLA_ACTIE_TO, ZOHO_SMTP_USER of ZOHO_SMTP_PASS ontbreekt – mail niet verstuurd");
    return res.status(204).end();
  }
  try {
    const mail = ellaActieMail(call);
    await mailer.sendMail(mail);
    handledCalls.set(call.call_id, Date.now());
    setTimeout(() => handledCalls.delete(call.call_id), 24 * 60 * 60 * 1000);
    console.log(`ELLA-ACTIE verstuurd: ${mail.subject}`);
    res.status(204).end();
  } catch (e) {
    // Geen 2xx: Retell probeert het tot 3 keer opnieuw
    console.error("ELLA-ACTIE", e.message);
    res.status(500).end();
  }
});

app.get("/health", (_req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Myvio order-agent op poort ${PORT}`));
