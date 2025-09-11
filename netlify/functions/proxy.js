// netlify/functions/proxy.js
const fetch = require("node-fetch");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-API-Key, X-Forward-Path, x-forward-path",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
};

function getHeaderCaseInsensitive(headers, key) {
  if (!headers) return undefined;
  const lower = Object.keys(headers).reduce((acc, k) => {
    acc[k.toLowerCase()] = headers[k];
    return acc;
  }, {});
  return lower[key.toLowerCase()];
}

function parseRawQueryToObj(raw) {
  const out = {};
  if (!raw || typeof raw !== "string") return out;
  const qs = raw.replace(/^\?/, "");
  if (!qs) return out;
  const pairs = qs.split("&");
  for (const p of pairs) {
    if (!p) continue;
    const idx = p.indexOf("=");
    if (idx === -1) {
      // key without value
      const key = decodeURIComponent(p);
      out[key] = "";
    } else {
      const key = decodeURIComponent(p.slice(0, idx));
      const val = decodeURIComponent(p.slice(idx + 1));
      // handle repeated keys -> array
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        if (Array.isArray(out[key])) out[key].push(val);
        else out[key] = [out[key], val];
      } else {
        out[key] = val;
      }
    }
  }
  return out;
}

exports.handler = async function (event, context) {
  // Handle preflight
  if ((event.httpMethod || event.method || "").toUpperCase() === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    const REQUIRED_KEY = process.env.PROXY_API_KEY || "";
    if (REQUIRED_KEY) {
      const incomingKey =
        getHeaderCaseInsensitive(event.headers, "x-api-key") || "";
      if (!incomingKey || incomingKey !== REQUIRED_KEY) {
        return {
          statusCode: 401,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "invalid_api_key" }),
        };
      }
    }

    const method = (event.httpMethod || event.method || "POST").toUpperCase();

    // Build payload:
    let payload = null;
    if (method === "GET") {
      // For GET, use parsed queryStringParameters (preferred)
      payload = event.queryStringParameters || {};
    } else {
      if (!event.body) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "empty_body" }),
        };
      }
      try {
        payload = JSON.parse(event.body);
      } catch (err) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "invalid_json" }),
        };
      }
    }

    // Basic type validation (if present)
    const typeLower = ((payload && payload.type) || "")
      .toString()
      .toLowerCase();
    if (typeLower) {
      if (typeLower === "deal") {
        const { dealer, customer, amount, dealDate, status } = payload;
        if (!dealer || !customer || !amount || !dealDate || !status) {
          return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ ok: false, error: "missing_fields" }),
          };
        }
      } else if (typeLower === "regular") {
        const {
          senderName,
          receiverName,
          amountTransferred,
          dealDate,
          status,
        } = payload;
        if (
          !senderName ||
          !receiverName ||
          !amountTransferred ||
          !dealDate ||
          !status
        ) {
          return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ ok: false, error: "missing_fields" }),
          };
        }
      } else {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "unknown_type" }),
        };
      }
    }

    // Compose upstream URL:
    const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
    if (!N8N_WEBHOOK_URL) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: "missing_n8n_webhook_env" }),
      };
    }

    const N8N_TRACKER_URL = process.env.N8N_TRACKER_URL || "";
    const N8N_TRACKER_SUGGESTIONS_URL =
      process.env.N8N_TRACKER_SUGGESTIONS_URL || "";

    const queryPath =
      (event.queryStringParameters && event.queryStringParameters.path) || "";
    const headerPath =
      getHeaderCaseInsensitive(event.headers, "x-forward-path") || "";
    const extraPath = (queryPath || headerPath || "").toString();

    const base = N8N_WEBHOOK_URL.replace(/\/+$/, "");
    let upstreamUrl = extraPath
      ? `${base}/${extraPath.replace(/^\/+/, "")}`
      : base;

    if (/^https?:\/\//i.test(extraPath)) {
      upstreamUrl = extraPath;
    }

    if (
      (extraPath === "tracker" || extraPath === "/tracker") &&
      N8N_TRACKER_URL
    ) {
      upstreamUrl = N8N_TRACKER_URL;
    } else if (
      (extraPath === "tracker/suggestions" ||
        extraPath === "/tracker/suggestions") &&
      N8N_TRACKER_SUGGESTIONS_URL
    ) {
      upstreamUrl = N8N_TRACKER_SUGGESTIONS_URL;
    }

    // Prepare headers to forward upstream
    const upstreamHeaders = {};
    if (method !== "GET") {
      upstreamHeaders["Content-Type"] = "application/json";
    }

    const N8N_USER = process.env.N8N_USER || "";
    const N8N_PASS = process.env.N8N_PASS || "";
    if (N8N_USER && N8N_PASS) {
      const creds = Buffer.from(`${N8N_USER}:${N8N_PASS}`).toString("base64");
      upstreamHeaders["Authorization"] = `Basic ${creds}`;
    } else {
      const incomingAuth =
        getHeaderCaseInsensitive(event.headers, "authorization") || "";
      if (incomingAuth) upstreamHeaders["Authorization"] = incomingAuth;
    }

    const forwardHeaderNames = [
      "x-api-key",
      "x-custom",
      "x-request-id",
      "user-agent",
      "accept",
    ];
    for (const hn of forwardHeaderNames) {
      const val =
        getHeaderCaseInsensitive(event.headers, hn) ||
        getHeaderCaseInsensitive(event.headers, hn.toUpperCase());
      if (val) upstreamHeaders[hn] = val;
    }

    // Build upstream fetch URL (robust handling of rawQuery vs parsed params)
    let upstreamFetchUrl = upstreamUrl;
    if (method === "GET") {
      // Prefer parsed object from queryStringParameters (Netlify provides it)
      let incomingQs = {};
      if (
        event.queryStringParameters &&
        typeof event.queryStringParameters === "object" &&
        Object.keys(event.queryStringParameters).length > 0
      ) {
        incomingQs = event.queryStringParameters;
      } else if (event.rawQuery && typeof event.rawQuery === "string") {
        // rawQuery is a string, parse it into an object
        incomingQs = parseRawQueryToObj(event.rawQuery);
      }

      const qsEntries = Object.entries(incomingQs).filter(([k]) => k !== "path");
      if (qsEntries.length) {
        // build querystring and support array values
        const qsParts = [];
        for (const [k, v] of qsEntries) {
          if (Array.isArray(v)) {
            for (const vv of v) {
              qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(vv)}`);
            }
          } else {
            qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
          }
        }
        const qs = qsParts.join("&");
        upstreamFetchUrl =
          upstreamUrl + (upstreamUrl.includes("?") ? "&" : "?") + qs;
      }
    }

    const fetchOptions = {
      method,
      headers: upstreamHeaders,
    };

    if (method !== "GET" && payload !== null) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const resp = await fetch(upstreamFetchUrl, fetchOptions);

    const text = await resp.text().catch(() => "");

    return {
      statusCode: resp.ok ? 200 : resp.status || 502,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: resp.ok,
        status: resp.status,
        upstreamBody: text.slice(0, 2000),
      }),
    };
  } catch (err) {
    console.error("proxy error", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: "internal_error",
        details: err && err.message ? err.message : String(err),
      }),
    };
  }
};
