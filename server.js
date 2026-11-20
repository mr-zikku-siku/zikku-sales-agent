// Zikku AI Sales Agent - Facebook Messenger webhook server (multi-shop: one agent, any Page)
// Receives Page messages, replies with Gemini AI, takes orders.
// Default shop config below is for the Premium Zad Page (NAYRA heels).
// Language: Bengali. Runs 24/7 on a cloud host (Firebase/Render).
//
// Env vars:
//   PAGE_ACCESS_TOKEN - Facebook Page access token (from Meta App)
//   VERIFY_TOKEN      - webhook verify token (choose a secret, same as in Meta App)
//   PORT              - port (default 3000)
// Gemini API key is read at runtime from ~/workspace/zoovi-web/public/zoovi-ai.js
// (the key lives only there; it is never copied into this file).

const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'zikku-verify-2026';
const GEMINI_MODEL = 'gemini-flash-lite-latest';

// ---- Gemini API key ----
// Priority: env var GEMINI_API_KEY, then the local Zoovi bot file,
// then the public Zoovi file (https://zoovi.web.app/zoovi-ai.js).
// The key value is never written into this file.
async function loadGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const p = path.join(process.env.HOME || '/home/hatch', 'workspace/zoovi-web/public/zoovi-ai.js');
    const src = fs.readFileSync(p, 'utf8');
    const m = src.match(/var API_KEY\s*=\s*'([^']+)'/);
    if (m) return m[1];
  } catch (e) { /* local file not present (e.g. on Render) */ }
  try {
    const res = await fetch('https://zoovi.web.app/zoovi-ai.js', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const src = await res.text();
      const m = src.match(/var API_KEY\s*=\s*'([^']+)'/);
      if (m) return m[1];
    }
  } catch (e) { /* offline */ }
  return '';
}
let GEMINI_KEY = '';

// ---- Shop knowledge (single source of truth) ----
const SHOP = {
  name: 'NAYRA',
  product: 'PREMIUM (BRAUN) HEELS',
  price: 1890,
  priceText: '৳১,৮৯০',
  delivery: 'ক্যাশ অন ডেলিভারি (COD)',
  deliveryFee: 'ফ্রি ডেলিভারি',
  heel: 'ব্লক হিল ২.৫ ইঞ্চি, গ্লসি প্যাটেন্ট, ডিপ মেরুন',
};

// ---- Simple per-user order state (in-memory; v1) ----
// state: 'idle' | 'await_name' | 'await_phone' | 'await_address' | 'await_confirm'
// order: { name, phone, address, qty }
const sessions = new Map();
function getSession(psid) {
  if (!sessions.has(psid)) sessions.set(psid, { state: 'idle', order: { qty: 1 } });
  return sessions.get(psid);
}

// ---- Gemini reply ----
async function geminiReply(userText, history) {
  const sys = [
    'You are the friendly sales assistant of the Bangladeshi online shop NAYRA.',
    'Reply ONLY in Bengali (Bangla script), warm and polite, like a helpful shopkeeper sister (আপু).',
    'Product: PREMIUM (BRAUN) HEELS, price ৳১,৮৯০, Cash on Delivery, FREE delivery.',
    'Heel: block heel 2.5 inch, glossy patent, deep maroon colour.',
    'If the customer asks the price, say ৳১,৮৯০, COD, free delivery.',
    'If the customer wants to order, ask for their name, then phone number, then full address, one at a time.',
    'Never invent another product, price, or delivery time. If asked about delivery time, say it will be confirmed after the order.',
    'Keep replies short (1-3 lines). Use a friendly tone. Do not mention that you are an AI unless asked.',
  ].join('\n');
  const contents = [];
  if (history && history.length) {
    for (const h of history.slice(-6)) contents.push(h);
  }
  contents.push({ role: 'user', parts: [{ text: userText }] });
  const body = {
    system_instruction: { parts: [{ text: sys }] },
    contents,
    generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(GEMINI_KEY);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
    ? data.candidates[0].content.parts.map(p => p.text || '').join('').trim()
    : '';
  return text;
}

// ---- Order-flow helpers ----
function isOrderIntent(text) {
  const t = (text || '').toLowerCase();
  return /অর্ডার|order|কিনতে|কিনব|নিতে চাই|নিব|চাই/.test(t);
}
function looksLikePhone(text) {
  const d = (text || '').replace(/[^0-9]/g, '');
  return d.length === 11 && d.startsWith('01');
}
function saveOrder(psid, order) {
  // v1: append to a local JSONL log. Later: write to the NAYRA dashboard RTDB / Google Sheet.
  const rec = { ts: new Date().toISOString(), psid, ...order, product: SHOP.product, price: SHOP.price, status: 'new' };
  try {
    fs.appendFileSync(path.join(__dirname, 'orders.jsonl'), JSON.stringify(rec) + '\n');
  } catch (e) { /* ignore */ }
  return rec;
}

// ---- Send a message via Facebook Graph API ----
async function sendMessage(psid, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.log('[DRY-RUN] would send to', psid, ':', text);
    return;
  }
  const url = 'https://graph.facebook.com/v19.0/me/messages?access_token=' + encodeURIComponent(PAGE_ACCESS_TOKEN);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Facebook send failed', res.status, t.slice(0, 300));
  }
}

// ---- Handle one incoming customer message ----
async function handleMessage(psid, text) {
  const sess = getSession(psid);
  const msg = (text || '').trim();

  // Order flow states
  if (sess.state === 'await_name') {
    sess.order.name = msg;
    sess.state = 'await_phone';
    return 'ধন্যবাদ, ' + msg + '! এখন আপনার মোবাইল নম্বরটি দিন।';
  }
  if (sess.state === 'await_phone') {
    if (!looksLikePhone(msg)) return 'নম্বরটি সঠিক মনে হচ্ছে না। অনুগ্রহ করে ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন 01XXXXXXXXX)।';
    sess.order.phone = msg.replace(/[^0-9]/g, '');
    sess.state = 'await_address';
    return 'ধন্যবাদ! এখন আপনার সম্পূর্ণ ঠিকানাটি লিখুন (বাসা/হোল্ডিং, রোড, এলাকা, থানা, জেলা)।';
  }
  if (sess.state === 'await_address') {
    sess.order.address = msg;
    sess.state = 'await_confirm';
    return 'অর্ডারটি দেখে নিন:\n• পণ্য: ' + SHOP.product + '\n• দাম: ' + SHOP.priceText + '\n• নাম: ' + sess.order.name + '\n• ফোন: ' + sess.order.phone + '\n• ঠিকানা: ' + sess.order.address + '\n• ডেলিভারি: ' + SHOP.delivery + ', ' + SHOP.deliveryFee + '\n\nসব ঠিক থাকলে "কনফার্ম" লিখুন।';
  }
  if (sess.state === 'await_confirm') {
    if (/কনফার্ম|confirm|হ্যাঁ|হ্যা|ঠিক আছে|ok/i.test(msg)) {
      const rec = saveOrder(psid, sess.order);
      sess.state = 'idle';
      sess.order = { qty: 1 };
      return 'আলহামদুলিল্লাহ! আপনার অর্ডারটি কনফার্ম হয়েছে। অর্ডার নম্বর: NAYRA-' + Date.now().toString().slice(-6) + '\nআমরা শীঘ্রই কল করে ডেলিভারি নিশ্চিত করবো। ধন্যবাদ!';
    }
    if (/বাতিল|cancel/i.test(msg)) {
      sess.state = 'idle';
      sess.order = { qty: 1 };
      return 'ঠিক আছে, অর্ডারটি বাতিল করা হয়েছে। আর কিছু জানতে চাইলে মেসেজ করুন।';
    }
    return 'অর্ডারটি কনফার্ম করতে "কনফার্ম" লিখুন, আর বাতিল করতে "বাতিল" লিখুন।';
  }

  // Idle: order intent starts the flow
  if (isOrderIntent(msg)) {
    sess.state = 'await_name';
    sess.order = { qty: 1 };
    return 'অবশ্যই! অর্ডার করতে আপনার নামটি লিখুন।';
  }

  // Otherwise: AI reply
  try {
    const reply = await geminiReply(msg, sess.history || []);
    if (reply) {
      sess.history = (sess.history || []).concat(
        { role: 'user', parts: [{ text: msg }] },
        { role: 'model', parts: [{ text: reply }] },
      ).slice(-8);
      return reply;
    }
  } catch (e) {
    console.error('Gemini failed:', e.message);
  }
  // Fallback (AI down): simple keyword answers
  if (/দাম|price|কত/.test(msg)) return 'আমাদের ' + SHOP.product + '-এর দাম ' + SHOP.priceText + '। ' + SHOP.delivery + ', ' + SHOP.deliveryFee + '। অর্ডার করতে "অর্ডার করতে চাই" লিখুন।';
  if (/ডেলিভারি|delivery/.test(msg)) return SHOP.delivery + ', ' + SHOP.deliveryFee + '। অর্ডার কনফার্ম হলে আমরা কল করে ডেলিভারির সময় জানিয়ে দেবো।';
  return 'আসসালামু আলাইকুম! NAYRA-তে স্বাগতম। ' + SHOP.product + ' (' + SHOP.priceText + ', COD, ফ্রি ডেলিভারি) সম্পর্কে জানতে "দাম কত?" লিখুন, আর অর্ডার করতে "অর্ডার করতে চাই" লিখুন।';
}

// ---- Webhook verification (GET) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- Webhook receiver (POST) ----
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  try {
    const body = req.body;
    if (body.object !== 'page') return;
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        if (ev.message && ev.message.text && ev.sender && ev.sender.id) {
          const psid = ev.sender.id;
          const text = ev.message.text;
          console.log('Incoming from', psid, ':', text.slice(0, 120));
          try {
            const reply = await handleMessage(psid, text);
            if (reply) await sendMessage(psid, reply);
          } catch (e) {
            console.error('handle failed:', e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('webhook error:', e.message);
  }
});

app.get('/', (req, res) => res.send("Zikku Sales Agent is running. Webhook: /webhook"));
app.get('/health', (req, res) => res.json({ ok: true, gemini: !!GEMINI_KEY, pageToken: !!PAGE_ACCESS_TOKEN }));

(async () => {
  GEMINI_KEY = await loadGeminiKey();
  app.listen(PORT, () => {
    console.log("Zikku Sales Agent listening on port " + PORT);
    console.log('Gemini key loaded:', !!GEMINI_KEY, '| Page token set:', !!PAGE_ACCESS_TOKEN);
  });
})();
