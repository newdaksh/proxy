// netlify/functions/proxy.js
const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  try {
    const REQUIRED_KEY = process.env.PROXY_API_KEY || "";
    if (REQUIRED_KEY) {
      const incomingKey = (event.headers['x-api-key'] || event.headers['X-API-KEY'] || '');
      if (!incomingKey || incomingKey !== REQUIRED_KEY) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'invalid_api_key' }) };
      }
    }

    // Determine incoming HTTP method
    const method = (event.httpMethod || event.method || 'POST').toUpperCase();

    // Build payload:
    // - For POST/PUT/PATCH expect JSON body (if empty => error)
    // - For GET, use query string params as payload (or leave empty)
    let payload = null;
    if (method === 'GET') {
      payload = event.queryStringParameters || {};
      // If you want to treat an empty GET as allowed, keep payload {}.
      // If you want to force a "name" or some param, validate below.
    } else {
      if (!event.body) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'empty_body' }) };
      }
      try {
        payload = JSON.parse(event.body);
      } catch (err) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
      }
    }

    // Basic validation example (keeps your existing 'type' check)
    const typeLower = ((payload && payload.type) || "").toString().toLowerCase();

    // If the endpoint is used for tracker, you can use `path=tracker` in query string
    // and skip type validation. We only validate when type is present.
    if (typeLower) {
      if (typeLower === 'deal') {
        const { dealer, customer, amount, dealDate, status } = payload;
        if (!dealer || !customer || !amount || !dealDate || !status) {
          return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing_fields' }) };
        }
      } else if (typeLower === 'regular') {
        const { senderName, receiverName, amountTransferred, dealDate, status } = payload;
        if (!senderName || !receiverName || !amountTransferred || !dealDate || !status) {
          return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing_fields' }) };
        }
      } else {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'unknown_type' }) };
      }
    }

    // Compose upstream URL:
    // - If N8N_WEBHOOK_URL is a full URL and a path param is provided, append it.
    // - If N8N_WEBHOOK_URL already contains full webhook path (no extra path param), you'll just hit it directly.
    const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
    if (!N8N_WEBHOOK_URL) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'missing_n8n_webhook_env' }) };
    }

    // Accept optional override path via query param or header:
    const queryPath = (event.queryStringParameters && event.queryStringParameters.path) || '';
    const headerPath = event.headers && (event.headers['x-forward-path'] || event.headers['X-Forward-Path']) || '';
    const extraPath = (queryPath || headerPath || '').toString();

    // Normalize base url (remove trailing slash)
    const base = N8N_WEBHOOK_URL.replace(/\/+$/, '');
    const upstreamUrl = extraPath ? `${base.replace(/\/+$/, '')}/${extraPath.replace(/^\/+/, '')}` : base;

    // Prepare headers to forward upstream
    const upstreamHeaders = {};

    // Forward Content-Type for POST where appropriate
    if (method !== 'GET') {
      upstreamHeaders['Content-Type'] = 'application/json';
    }

    // Basic auth precedence: env creds > incoming Authorization header
    const N8N_USER = process.env.N8N_USER || '';
    const N8N_PASS = process.env.N8N_PASS || '';
    if (N8N_USER && N8N_PASS) {
      const creds = Buffer.from(`${N8N_USER}:${N8N_PASS}`).toString('base64');
      upstreamHeaders['Authorization'] = `Basic ${creds}`;
    } else if (event.headers && (event.headers.authorization || event.headers.Authorization)) {
      upstreamHeaders['Authorization'] = event.headers.authorization || event.headers.Authorization;
    }

    // Forward certain incoming headers if useful (but avoid host-related headers)
    const forwardHeaderNames = ['x-api-key', 'x-custom', 'x-request-id', 'user-agent', 'accept'];
    for (const hn of forwardHeaderNames) {
      const low = hn.toLowerCase();
      if (event.headers && event.headers[low]) {
        upstreamHeaders[hn] = event.headers[low];
      } else if (event.headers && event.headers[hn.toUpperCase()]) {
        upstreamHeaders[hn] = event.headers[hn.toUpperCase()];
      }
    }

    // Do the upstream fetch - forward method as-is
    const fetchOptions = {
      method,
      headers: upstreamHeaders,
    };

    if (method !== 'GET' && payload !== null) {
      fetchOptions.body = JSON.stringify(payload);
    } else {
      // For GET, include query params in the upstream URL if you want them
      // (we already created upstreamUrl from base+path, but you might want to forward the original querystring)
      // To forward the original querystring, you can append it:
      const incomingQs = event.rawQuery || event.queryStringParameters || {};
      const qsEntries = Object.entries(incomingQs).filter(([k]) => k !== 'path'); // drop path
      if (qsEntries.length) {
        const qs = qsEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        // append with proper separator
        upstreamUrl = upstreamUrl + (upstreamUrl.includes('?') ? '&' : '?') + qs;
      }
    }

    // perform fetch (note: upstreamUrl might have been modified above)
    const resp = await fetch(upstreamUrl, fetchOptions);

    // try to return upstream body as text (limit response size)
    const text = await resp.text().catch(() => '');

    return {
      statusCode: resp.ok ? 200 : (resp.status || 502),
      body: JSON.stringify({ ok: resp.ok, status: resp.status, upstreamBody: text.slice(0, 2000) })
    };

  } catch (err) {
    console.error('proxy error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'internal_error', details: err.message }) };
  }
};
