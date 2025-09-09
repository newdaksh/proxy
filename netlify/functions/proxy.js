// netlify/functions/proxy.js
// Updated proxy for Netlify functions — adds CORS handling and more robust header handling.
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

exports.handler = async function (event, context) {
  // Respond to preflight quickly
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

    // Determine incoming HTTP method
    const method = (event.httpMethod || event.method || "POST").toUpperCase();

    // Build payload:
    let payload = null;
    if (method === "GET") {
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

    // Optional explicit per-endpoint overrides (full URLs)
    const N8N_TRACKER_URL = process.env.N8N_TRACKER_URL || "";
    const N8N_TRACKER_SUGGESTIONS_URL =
      process.env.N8N_TRACKER_SUGGESTIONS_URL || "";

    // Accept optional override path via query param or header:
    const queryPath =
      (event.queryStringParameters && event.queryStringParameters.path) || "";
    const headerPath =
      getHeaderCaseInsensitive(event.headers, "x-forward-path") || "";
    const extraPath = (queryPath || headerPath || "").toString();

    // Normalize base url (remove trailing slash)
    const base = N8N_WEBHOOK_URL.replace(/\/+$/, "");

    // build upstreamUrl (let because we may reassign)
    let upstreamUrl = extraPath
      ? `${base}/${extraPath.replace(/^\/+/, "")}`
      : base;

    // fallback: if extraPath looks like a full URL, use it directly
    if (/^https?:\/\//i.test(extraPath)) {
      upstreamUrl = extraPath;
    }

    // If caller specifically asked for tracker endpoints and we have explicit env overrides, use them
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

    // Forward Content-Type for POST where appropriate
    if (method !== "GET") {
      upstreamHeaders["Content-Type"] = "application/json";
    }

    // Basic auth precedence: env creds > incoming Authorization header
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

    // Forward certain incoming headers if useful (but avoid host-related headers)
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

    // For GET, optionally forward original querystring parameters (except 'path')
    let upstreamFetchUrl = upstreamUrl;
    if (method === "GET") {
      const incomingQs = event.rawQuery || event.queryStringParameters || {};
      const qsEntries = Object.entries(incomingQs).filter(
        ([k]) => k !== "path"
      );
      if (qsEntries.length) {
        const qs = qsEntries
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        upstreamFetchUrl =
          upstreamUrl + (upstreamUrl.includes("?") ? "&" : "?") + qs;
      }
    }

    // Do the upstream fetch - forward method as-is
    const fetchOptions = {
      method,
      headers: upstreamHeaders,
    };

    if (method !== "GET" && payload !== null) {
      fetchOptions.body = JSON.stringify(payload);
    }

    // perform fetch
    const resp = await fetch(upstreamFetchUrl, fetchOptions);

    // try to return upstream body as text (limit response size)
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
