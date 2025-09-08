// netlify/functions/proxy.js
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  try {
    // --- simple API key check (optional, but recommended) ---
    const REQUIRED_KEY = process.env.PROXY_API_KEY || ""; // set in Netlify UI
    if (REQUIRED_KEY) {
      const incomingKey = (event.headers['x-api-key'] || event.headers['X-API-KEY'] || '');
      if (!incomingKey || incomingKey !== REQUIRED_KEY) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'invalid_api_key' }) };
      }
    }

    // --- parse body ---
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'empty_body' }) };
    }

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
    }

    // basic validation of your fields (adapt as needed)
    const { dealer, customer, amount, dealDate, status } = payload;
    if (!dealer || !customer || !amount || !dealDate || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing_fields' }) };
    }

    // --- forward to n8n webhook ---
    const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
    if (!N8N_WEBHOOK_URL) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'missing_n8n_webhook_env' }) };
    }

    // Prepare headers for upstream
    const upstreamHeaders = { 'Content-Type': 'application/json' };

    // If N8N credentials exist, add Basic Auth header
    const N8N_USER = process.env.N8N_USER || '';
    const N8N_PASS = process.env.N8N_PASS || '';
    if (N8N_USER && N8N_PASS) {
      const creds = Buffer.from(`${N8N_USER}:${N8N_PASS}`).toString('base64');
      upstreamHeaders['Authorization'] = `Basic ${creds}`;
    }

    // Forward request
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload),
      timeout: 10000
    });

    const text = await resp.text().catch(() => '');
    // Return simplified response to client (avoid leaking secrets)
    return {
      statusCode: resp.ok ? 200 : 502,
      body: JSON.stringify({ ok: resp.ok, status: resp.status, upstreamBody: text.slice(0, 2000) })
    };

  } catch (err) {
    console.error('proxy error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
