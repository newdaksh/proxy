# Chatbot AI Agent Integration Setup

## Overview

The proxy has been updated to support the new AI agent chatbot workflow with Google Gemini integration.

## Environment Variables Required

Add this new environment variable to your Netlify deployment:

```
N8N_CHATBOT_WEBHOOK_URL=https://your-n8n-instance.com/webhook/bc4725b9-0a5f-42ae-a569-953fdf4efbcd
```

**Note:** Replace the webhook ID `bc4725b9-0a5f-42ae-a569-953fdf4efbcd` with the actual webhook ID from your n8n workflow.

## Complete Environment Variables List

For reference, your Netlify environment should have:

```
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/your-main-webhook-id
N8N_TRACKER_URL=https://your-n8n-instance.com/webhook/your-tracker-webhook-id
N8N_TRACKER_SUGGESTIONS_URL=https://your-n8n-instance.com/webhook/your-suggestions-webhook-id
N8N_CHATBOT_WEBHOOK_URL=https://your-n8n-instance.com/webhook/bc4725b9-0a5f-42ae-a569-953fdf4efbcd
N8N_USER=your-basic-auth-username
N8N_PASS=your-basic-auth-password
PROXY_API_KEY=your-api-key
```

## Routing Changes Made

### New Route Added

- **Path:** `webhook-chatbot` or `/webhook-chatbot`
- **Method:** POST
- **Purpose:** Routes chatbot messages to the AI agent workflow
- **Payload Format:**
  ```json
  {
    "message": "User's question or message",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
  ```

### Validation Updates

- Added validation for chatbot message format
- Requires `message` field to be non-empty string
- Allows requests without `type` field for chatbot messages
- Maintains existing validation for `deal` and `regular` types

## API Flow

1. **Mobile App** → `ApiService.chatWithAI(message)`
2. **ApiService** → `POST /proxy?path=webhook-chatbot` with message payload
3. **Netlify Proxy** → Routes to `N8N_CHATBOT_WEBHOOK_URL`
4. **n8n Workflow** → AI Agent processes with Google Gemini + Google Sheets tools
5. **Response Chain** → n8n → Proxy → ApiService → ChatBot UI

## Testing

You can test the integration by:

1. **Direct API Test:**

   ```bash
   curl -X POST "https://your-netlify-proxy.netlify.app/.netlify/functions/proxy?path=webhook-chatbot" \
     -H "Content-Type: application/json" \
     -H "X-API-Key: your-api-key" \
     -d '{"message": "Show me all deals from this month", "timestamp": "2024-01-15T10:30:00.000Z"}'
   ```

2. **Mobile App Test:**
   - Open the chatbot in your React Native app
   - Send a message like "Show me recent deals"
   - The AI should respond with intelligent analysis from your Google Sheets

## Error Handling

The proxy now handles:

- Missing or empty message validation
- Proper error responses for chatbot requests
- Fallback to existing deal/regular validation for non-chatbot requests

## Files Modified

1. **proxy.js** - Added chatbot routing and validation
2. **ApiService.ts** - Added `chatWithAI()` method
3. **ChatBot.tsx** - Updated to use AI agent instead of simple search

## Next Steps

1. Deploy the updated `proxy.js` to Netlify
2. Add the `N8N_CHATBOT_WEBHOOK_URL` environment variable
3. Test the chatbot functionality
4. Monitor logs for any integration issues
