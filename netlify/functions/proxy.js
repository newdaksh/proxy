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

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'empty_body' }) };
    }

    let incoming;
    try {
      incoming = JSON.parse(event.body);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_json' }) };
    }

    // Incoming payload directly (no wrapping under "body")
    const payload = incoming;

    // Basic 'type' check (lowercased) for validation
    const typeLower = (payload && payload.type || "").toString().toLowerCase();

    if (!typeLower) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'missing_type' }) };
    }

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

    const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
    if (!N8N_WEBHOOK_URL) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'missing_n8n_webhook_env' }) };
    }

    const upstreamHeaders = { 'Content-Type': 'application/json' };

    const N8N_USER = process.env.N8N_USER || '';
    const N8N_PASS = process.env.N8N_PASS || '';
    if (N8N_USER && N8N_PASS) {
      const creds = Buffer.from(`${N8N_USER}:${N8N_PASS}`).toString('base64');
      upstreamHeaders['Authorization'] = `Basic ${creds}`;
    } else if (event.headers && (event.headers.authorization || event.headers.Authorization)) {
      upstreamHeaders['Authorization'] = event.headers.authorization || event.headers.Authorization;
    }

    // Always forward the plain payload (no "body" wrapper)
    const forwardedPayload = payload;

    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(forwardedPayload),
    });

    const text = await resp.text().catch(() => '');

    return {
      statusCode: resp.ok ? 200 : 502,
      body: JSON.stringify({ ok: resp.ok, status: resp.status, upstreamBody: text.slice(0, 2000) })
    };

  } catch (err) {
    console.error('proxy error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
