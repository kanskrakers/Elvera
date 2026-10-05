// Myvio order-agent middleware
// Retell (custom function) -> deze server -> Shopify Admin API + 17TRACK
// Eén server bedient meerdere stores: de store wordt bepaald via het Retell agent_id.

import express from "express";
import Retell from "retell-sdk";

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

// ---------- Shopify ----------
async function shopify(store, query, variables) {
  const res = await fetch(
    `https://${store.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": store.token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(4000),
    }
  );
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

app.get("/health", (_req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Myvio order-agent op poort ${PORT}`));
