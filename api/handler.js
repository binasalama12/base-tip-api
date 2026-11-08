const PAY_TO = "0x34c002e40fd499156340c385f3d1f19011b29942";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR = "https://x402.org/facilitator";
const BASE_RPC = "https://mainnet.base.org";

function baseOf(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return proto + "://" + host;
}

function offerFor(req) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: baseOf(req) + "/paid",
      description: "Latest Base mainnet block number and UTC timestamp, in one call.",
      mimeType: "application/json",
      serviceName: "Base Tip",
    },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: USDC_BASE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: { name: "USD Coin", version: "2" },
    }],
  };
}

function sendJson(res, status, obj, extra) {
  const headers = Object.assign({
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  }, extra || {});
  for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  try {
    const path = (req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type, PAYMENT-SIGNATURE");
      res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === "GET" && path === "/openapi.json") {
      const offer = offerFor(req);
      return sendJson(res, 200, {
        openapi: "3.0.3",
        info: { title: "Base Tip", version: "1.0.0", description: offer.resource.description },
        servers: [{ url: baseOf(req) }],
        paths: {
          "/paid": {
            post: {
              "x-payment-info": offer.accepts[0],
              responses: {
                "200": { description: "Paid response" },
                "402": { description: "Payment required" },
              },
            },
          },
        },
      });
    }
    if (req.method === "GET" && path === "/") {
      return sendJson(res, 200, { name: "Base Tip", paidEndpoint: "/paid", openapi: "/openapi.json" });
    }
    if (req.method === "POST" && path === "/paid") {
      const offer = offerFor(req);
      const encoded = req.headers["payment-signature"];
      if (!encoded) {
        return sendJson(res, 402, offer, {
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(offer)).toString("base64"),
        });
      }
      let payment;
      try {
        payment = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      } catch {
        return sendJson(res, 400, { error: "Invalid payment" });
      }
      const body = { x402Version: 2, paymentPayload: payment, paymentRequirements: offer.accepts[0] };
      const headers = { "content-type": "application/json" };
      const verify = await fetch(FACILITATOR + "/verify", { method: "POST", headers, body: JSON.stringify(body) });
      const verified = await verify.json().catch(() => ({}));
      if (!verify.ok || !verified.isValid) return sendJson(res, 402, { error: "Payment verification failed" });
      const settle = await fetch(FACILITATOR + "/settle", { method: "POST", headers, body: JSON.stringify(body) });
      const settlement = await settle.json().catch(() => ({}));
      if (!settle.ok || !settlement.success) return sendJson(res, 502, { error: "Payment settlement failed" });
      let blockNumber = null;
      try {
        const r = await fetch(BASE_RPC, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
        const d = await r.json();
        blockNumber = parseInt(d.result, 16);
      } catch {}
      return sendJson(res, 200, { network: "base", blockNumber, timestampUtc: new Date().toISOString() }, {
        "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settlement)).toString("base64"),
      });
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, { error: String((err && err.message) || err) });
  }
};
