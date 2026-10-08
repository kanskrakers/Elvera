// Myvio order-agent middleware
// Retell (custom function) -> deze server -> Shopify Admin API + 17TRACK
// Eén server bedient meerdere stores: de store wordt bepaald via het Retell agent_id.

import express from "express";
import Retell from "retell-sdk";
import nodemailer from "nodemailer";

const app = express();
app.use(express.json());

const {
  PORT = 3000,
  RETELL_API_KEY,
  TRACK17_API_KEY,
  STORES = "",
  SHOPIFY_API_VERSION = "2026-07", // check de nieuwste stabiele versie in de Shopify-docs
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
  const ok = signature && Retell.verify(JSON.stringify(req.body), RETELL_API_KEY, signature);
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Max 3 mislukte verificaties per gesprek (tegen uitproberen van ordernummers)
const failedAttempts = new Map();
function tooManyAttempts(callId) {
  return (failedAttempts.get(callId) || 0) >= 3;
}
function registerFail(callId) {
  failedAttempts.set(callId, (failedAttempts.get(callId) || 0) + 1);
  setTimeout(() => failedAttempts.delete(callId), 60 * 60 * 1000);
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

const ORDER_QUERY = `
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
      shippingAddress { zip address1 city countryCodeV2 }
      lineItems(first: 20) { nodes { title variantTitle quantity } }
      fulfillments(first: 5) {
        displayStatus
        createdAt
        estimatedDeliveryAt
        trackingInfo(first: 1) { number company url }
      }
    }
  }
}`;

const norm = (s = "") => String(s).toLowerCase().replace(/\s+/g, "");
const digits = (s = "") => String(s).replace(/\D/g, "");

async function findOrder(store, orderNumber) {
  const name = String(orderNumber).replace(/[^0-9a-z]/gi, "");
  const data = await shopify(store, ORDER_QUERY, { q: `name:#${name}` });
  return data.orders.nodes[0] || null;
}

// Verificatie: ordernummer + (e-mail OF postcode), of beller-ID = telefoon op order
function isVerified(order, { email, postcode }, fromNumber) {
  if (email && norm(email) === norm(order.email)) return true;
  if (postcode && norm(postcode) === norm(order.shippingAddress?.zip)) return true;
  if (fromNumber && order.phone && digits(fromNumber).slice(-9) === digits(order.phone).slice(-9)) return true;
  return false;
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
app.post("/retell/lookup_order", verifyRetell, async (req, res) => {
  const { call, args, store } = parse(req);
  try {
    if (tooManyAttempts(call.call_id)) {
      return res.json({ resultaat: "te_veel_pogingen", instructie: "Verwijs de klant naar e-mailsupport." });
    }
    const order = await findOrder(store, args.order_number);
    if (!order || !isVerified(order, args, call.from_number)) {
      registerFail(call.call_id);
      // Bewust geen onderscheid tussen 'bestaat niet' en 'klopt niet' (privacy)
      return res.json({ resultaat: "niet_geverifieerd", instructie: "Vraag de klant het ordernummer en e-mailadres of postcode te controleren." });
    }

    const f = order.fulfillments[0];
    const tracking = f?.trackingInfo?.[0];
    const live = await trackingStatus(tracking?.number);

    res.json({
      resultaat: "gevonden",
      order: order.name,
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
    res.json({ resultaat: "fout", instructie: "Excuseer je en bied aan dat het team per e-mail terugkomt." });
  }
});

// ---------- Function 2: verify_address ----------
// Klant noemt zelf postcode + huisnummer; wij zeggen alleen of het klopt.
app.post("/retell/verify_address", verifyRetell, async (req, res) => {
  const { call, args, store } = parse(req);
  try {
    if (tooManyAttempts(call.call_id)) return res.json({ resultaat: "te_veel_pogingen" });
    const order = await findOrder(store, args.order_number);
    if (!order || !isVerified(order, args, call.from_number)) {
      registerFail(call.call_id);
      return res.json({ resultaat: "niet_geverifieerd" });
    }
    const a = order.shippingAddress || {};
    const zipOk = norm(args.postcode) === norm(a.zip);
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
    "Open the link and enter the email address you ordered with.",
    "In your customer portal you can move your next delivery, change how often it comes, pause, update your address or payment details, or cancel your subscription.",
    "",
    "Please make any changes at least 24 hours before your next payment date. You'll see that date in the portal.",
    "",
    "If anything doesn't work, just reply to this email and we'll sort it for you.",
    "",
    "Kind regards,",
    `The ${MAIL_BRAND} team`,
  ].join("\n");

  const html = `<p>Hello,</p>
<p>Thank you for calling ${MAIL_BRAND}. As discussed on the phone, here is the link to your customer portal:</p>
<p><a href="${CANCEL_LINK_URL}"><strong>Open my customer portal</strong></a></p>
<p>Or copy this link into your browser:<br>
<a href="${CANCEL_LINK_URL}">${CANCEL_LINK_URL}</a></p>
<p>Open the link and enter the email address you ordered with. In your customer portal you can move your next delivery, change how often it comes, pause, update your address or payment details, or cancel your subscription.</p>
<p>Please make any changes at least 24 hours before your next payment date. You'll see that date in the portal.</p>
<p>If anything doesn't work, just reply to this email and we'll sort it for you.</p>
<p>Kind regards,<br>The ${MAIL_BRAND} team</p>`;

  return {
    from: `"${MAIL_BRAND}" <${ZOHO_SMTP_USER}>`,
    replyTo: ZOHO_SMTP_USER,
    to,
    subject: `Your ${MAIL_BRAND} customer portal link`,
    text,
    html,
  };
}

app.post("/retell/send_cancel_link_email", verifyRetell, async (req, res) => {
  const { call, args, store } = parse(req);
  try {
    if (!ZOHO_SMTP_USER || !ZOHO_SMTP_PASS || !CANCEL_LINK_URL) {
      console.error("send_cancel_link_email: ZOHO_SMTP_USER, ZOHO_SMTP_PASS of CANCEL_LINK_URL ontbreekt");
      return res.json({ resultaat: "fout", instructie: "Log het opzegverzoek voor het team (cancel_by_team)." });
    }
    if (tooManyAttempts(call.call_id)) {
      return res.json({ resultaat: "te_veel_pogingen", instructie: "Verwijs de klant naar e-mailsupport." });
    }
    if (tooManyMails(call.call_id)) {
      return res.json({ resultaat: "al_verstuurd", instructie: "De mail is al twee keer verstuurd. Laat het team het opzeggen overnemen." });
    }
    const order = await findOrder(store, args.order_number);
    if (!order || !isVerified(order, args, call.from_number)) {
      registerFail(call.call_id);
      return res.json({ resultaat: "niet_geverifieerd", instructie: "Vraag de klant het ordernummer en e-mailadres of postcode te controleren." });
    }
    if (!order.email) {
      return res.json({ resultaat: "geen_email", instructie: "Er staat geen e-mailadres op de order. Laat het team het opzeggen overnemen." });
    }

    await mailer.sendMail(cancelMail(order.email));
    registerMail(call.call_id);
    console.log(`send_cancel_link_email verstuurd voor order ${order.name}`);
    // Het e-mailadres zelf gaat NIET terug naar de agent
    res.json({ resultaat: "verstuurd" });
  } catch (e) {
    console.error("send_cancel_link_email", e.message);
    res.json({ resultaat: "fout", instructie: "Excuseer je en log het opzegverzoek voor het team (cancel_by_team)." });
  }
});

app.get("/health", (_req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Myvio order-agent op poort ${PORT}`));
