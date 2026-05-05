const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  ZAPI_INSTANCE_ID,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN,
} = process.env;

if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY ausente");
if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) throw new Error("Z-API creds ausentes");

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const sessions = new Map();

function loadPrompt() {
  const raw = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf-8").trim();
  if (!raw) return "Você é um atendente virtual amigável. Responda de forma curta e natural em português brasileiro.";
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key) => process.env[key] ?? `{{${key}}}`);
}
const SYSTEM_PROMPT = loadPrompt();

const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

async function sendText(phone, message) {
  const headers = { "Content-Type": "application/json" };
  if (ZAPI_CLIENT_TOKEN) headers["Client-Token"] = ZAPI_CLIENT_TOKEN;

  const resp = await fetch(`${ZAPI_BASE}/send-text`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phone, message }),
    signal: AbortSignal.timeout(30_000),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Z-API ${resp.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

async function getReply(session, userMessage) {
  session.messages.push({ role: "user", content: userMessage });
  const resp = await claude.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: session.messages,
  });
  const reply = resp.content[0].text;
  session.messages.push({ role: "assistant", content: reply });
  return reply;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) =>
  res.json({ status: "ok", sessions: sessions.size, model: ANTHROPIC_MODEL })
);

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body || {};
    if (body.fromMe === true) return;
    if (body.isGroup === true) return;

    const phone = String(body.phone || "").replace(/\D/g, "");
    const text = body.text?.message || body.message || body.body || "";
    if (!phone || !text) return;

    console.log(`📩 ${phone}: ${text}`);

    if (!sessions.has(phone)) sessions.set(phone, { messages: [] });
    const session = sessions.get(phone);

    const reply = await getReply(session, text);
    console.log(`💬 ${phone}: ${reply}`);
    await sendText(phone, reply);
    console.log(`✅ ${phone} entregue`);
  } catch (err) {
    console.error("❌", err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 odontozap rodando na :${PORT}`));
