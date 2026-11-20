# NAYRA AI Sales Agent — Facebook Messenger bot

24/7 AI sales agent for the NAYRA Facebook Page. Answers price questions,
takes orders (name → phone → address → confirm) and saves them.

## What it does
- Customer: "আপু, দাম কত?" → AI replies in Bengali: ৳১,৮৯০, COD, free delivery.
- Customer: "অর্ডার করতে চাই" → asks name, phone (11-digit 01…), address,
  shows a summary, waits for "কনফার্ম", then saves the order.
- Orders are appended to `orders.jsonl` (v1). Later: write to the NAYRA
  dashboard RTDB / Google Sheet so they appear in the dashboard.

## Files
- `server.js` — Express webhook server (GET /webhook verify, POST /webhook receive)
- `package.json` — express dependency
- `orders.jsonl` — saved orders (created on first confirmed order)

## How it works
1. Facebook sends each Page message to POST /webhook.
2. Server replies with Gemini (`gemini-flash-lite-latest`, same key as Zoovi bot).
   The Gemini key is read at runtime from `~/workspace/zoovi-web/public/zoovi-ai.js`
   — it is never copied into this project.
3. Server sends the reply via Facebook Graph API (`PAGE_ACCESS_TOKEN`).

## Test (local, done 2026-11-20)
- Webhook verify: correct token → challenge, wrong token → 403. PASS.
- "আপু, দাম কত?" → AI Bengali reply (৳১,৮৯০, COD, free delivery). PASS.
- Full order flow (name/phone/address/confirm) → order saved to orders.jsonl. PASS.

## To go live (needs Sir)
1. **Meta App**: developers.facebook.com → create app → add Messenger product.
2. **Connect Page**: in the app, select the NAYRA Page → get Page Access Token.
3. **Webhook**: set Callback URL to the deployed server `/webhook`,
   Verify Token `nayra-verify-2026`, subscribe to `messages`.
4. **Deploy**: host the server 24/7 (see Hosting below) with env vars:
   `PAGE_ACCESS_TOKEN`, `VERIFY_TOKEN=nayra-verify-2026`, `PORT`.
5. **App Review**: submit `pages_messaging` for review so real customers
   (not just testers) can chat. Test mode works without review.

## Hosting & cost
- **Firebase Cloud Functions (Blaze plan)**: needs a billing card on file.
  Free tier (2M invocations/mo, 400k GB-seconds) covers a small shop —
  monthly bill is $0 in practice. Card is only on file; Sir adds it himself.
  NOTE: Spark (free, no card) BLOCKS outbound calls to Facebook, so Blaze is required.
- **Alternative (no card)**: Render free tier (Node.js web service) + a free
  uptime monitor pinging it every 5 min to keep it awake. $0.
- **Gemini AI**: free tier (same key as Zoovi). $0 for shop volume.
- **Orders storage**: local JSONL now; RTDB/Sheet later (free tier).

## Status
- v1 server built + locally tested (2026-11-20 05:54). NOT yet deployed,
  NOT yet connected to the Page. Awaiting: Page name/link + deploy choice.
