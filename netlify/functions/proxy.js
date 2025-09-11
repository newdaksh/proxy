// netlify/functions/proxy.js
// Updated proxy with debug logging + tracker date normalization (startDate/endDate).
// WARNING: This version includes verbose logging and upstream body echo for staging/debug.
// Remove or reduce logging and the echoed upstreamBody/forwardedPayload before production.

const fetch = require("node-fetch");

const DEV_MODE = true; // set to false before production to reduce verbose output

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-API-Key, X-Forward-Path, x-forward-path, X-Normalize-Date",
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

function parseJSONSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Convert a local Date object (constructed using local year/month/day) to an ISO UTC string
function toISOStringUTC(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())).toISOString();
}

// Given either "YYYY-MM-DD" or an ISO string, compute local start/end of that calendar date
function computeStartEndFromDateString(input) {
  if (!input) return null;
  // If it's already a YYYY-MM-DD:
  const ymdMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10) - 1;
    const d = parseInt(ymdMatch[3], 10);
    const startLocal = new Date(y, m, d, 0, 0, 0, 0);
    const endLocal = new Date(y, m, d, 23, 59, 59, 999);
    return { startISO: startLocal.toISOString(), endISO: endLocal.toISOString() };
  }
  // Try parse as ISO-like string
  const dt = new Date(input);
  if (!isNaN(dt.getTime())) {
    // create a local date (calendar date in local timezone)
    const localDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const startLocal = new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate(), 0, 0, 0, 0);
    const endLocal = new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate(), 23, 59, 59, 999);
    // Use ISO strings (these are in UTC representation)
    return { startISO: startLocal.toISOString(), endISO: endLocal.toISOString() };
  }
  return null;
}

exports.handler = async (event) => {
  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      };
    }

    const method = event.httpMethod || "GET";
    const rawQuery = event.rawQuery || "";
    const qparams = event.queryStringParameters || {};
    const forwardPath = qparams.path || getHeaderCaseInsensitive(event.headers, "x-forward-path") || qparams.forwardPath || "";

    if (DEV_MODE) {
      console.log("=== proxy incoming ===");
      console.log("method:", method);
      console.log("rawQuery:", rawQuery);
      console.log("queryStringParameters:", JSON.stringify(qparams || {}));
      console.log("headers:", JSON.stringify(event.headers || {}));
      console.log("forwardPath:", forwardPath);
    }

    // Parse payload for non-GET
    let payload = {};
    if (method !== "GET") {
      const rawBody = event.body || "";
      const parsed = parseJSONSafe(rawBody);
      if (parsed === null) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: "invalid_json" }),
        };
      }
      payload = parsed;
    } else {
      // For GET, merge query params into payload to make testing easier
      payload = Object.assign({}, qparams);
    }

    if (DEV_MODE) {
      console.log("proxy parsed payload:", JSON.stringify(payload));
    }

    // Compose upstream URL
    // If you use per-path env vars like N8N_TRACKER_URL or a single N8N_WEBHOOK_URL,
    // this logic will pick tracker-specific URL when path === "tracker".
    const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
    const N8N_TRACKER_URL = process.env.N8N_TRACKER_URL || "";
    let upstreamFetchUrl = N8N_WEBHOOK_URL;
    if (forwardPath && forwardPath.toLowerCase() === "tracker" && N8N_TRACKER_URL) {
      upstreamFetchUrl = N8N_TRACKER_URL;
    }

    if (!upstreamFetchUrl) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: "missing_upstream" }),
      };
    }

    // If this is the tracker endpoint and the client sent `date` (but not startDate/endDate),
    // compute startDate & endDate and attach them. This avoids timezone matching problems.
    try {
      const shouldNormalize = Boolean(getHeaderCaseInsensitive(event.headers, "x-normalize-date") || getHeaderCaseInsensitive(event.headers, "X-Normalize-Date") || qparams.normalizeDate === "1" || qparams.normalizeDate === "true");
      if (forwardPath && forwardPath.toLowerCase() === "tracker") {
        // If user sent date and not startDate/endDate, compute them.
        if ((payload.date || payload.dealDate) && !payload.startDate && !payload.endDate) {
          const dateInput = payload.date || payload.dealDate;
          const computed = computeStartEndFromDateString(dateInput);
          if (computed) {
            // Attach startDate/endDate as ISO strings.
            payload.startDate = computed.startISO;
            payload.endDate = computed.endISO;
            if (DEV_MODE) {
              console.log("Normalized date -> startDate/endDate:", payload.startDate, payload.endDate);
            }
          } else if (shouldNormalize) {
            // If requested to normalize but parse failed, still return helpful error in dev
            if (DEV_MODE) console.warn("Could not parse provided date for normalization:", dateInput);
          }
        }
      }
    } catch (err) {
      if (DEV_MODE) console.warn("Date normalization failed:", err && err.message ? err.message : String(err));
    }

    // Prepare headers to forward
    const upstreamHeaders = {};
    const forwardHeaderNames = [
      "x-api-key",
      "x-forward-path",
      "x-request-id",
      "user-agent",
      "accept",
      "content-type",
      "authorization",
    ];
    // Add any custom headers you want forwarded by default:
    const customForward = ["x-custom", "x-normalize-date"];
    forwardHeaderNames.push(...customForward);

    (forwardHeaderNames || []).forEach((hn) => {
      const val = getHeaderCaseInsensitive(event.headers, hn);
      if (val) upstreamHeaders[hn] = val;
    });

    // If environment has n8n basic auth, attach it
    const N8N_USER = process.env.N8N_USER || "";
    const N8N_PASS = process.env.N8N_PASS || "";
    if (N8N_USER && N8N_PASS) {
      const creds = Buffer.from(`${N8N_USER}:${N8N_PASS}`).toString("base64");
      upstreamHeaders["Authorization"] = `Basic ${creds}`;
    } else {
      // if incoming Authorization exists, forward it
      const incomingAuth = getHeaderCaseInsensitive(event.headers, "authorization") || "";
      if (incomingAuth) upstreamHeaders["Authorization"] = incomingAuth;
    }

    if (method !== "GET") upstreamHeaders["Content-Type"] = "application/json";

    if (DEV_MODE) {
      console.log("Will forward to:", upstreamFetchUrl);
      console.log("Forward headers:", JSON.stringify(upstreamHeaders));
      console.log("Forward payload:", JSON.stringify(payload));
    }

    // Perform fetch
    const resp = await fetch(upstreamFetchUrl, {
      method,
      headers: upstreamHeaders,
      body: method === "GET" ? undefined : JSON.stringify(payload),
    });

    const text = await resp.text();

    // Return upstream response (in DEV_MODE we include full upstream body + forwarded payload)
    const responseBody = {
      ok: resp.ok,
      status: resp.status,
    };

    if (DEV_MODE) {
      // rich debug info
      responseBody.upstreamBody = text;
      responseBody.forwardedPayload = payload;
      responseBody.upstreamUrl = upstreamFetchUrl;
    } else {
      // production: keep minimal
      responseBody.upstreamBody = text && text.length > 2000 ? text.slice(0, 2000) : text;
    }

    return {
      statusCode: resp.status || 200,
      headers: corsHeaders,
      body: JSON.stringify(responseBody),
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
