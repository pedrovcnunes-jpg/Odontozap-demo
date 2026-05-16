const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const Groq = require("groq-sdk");
require("dotenv").config();

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE,
  OWNER_PHONE,
  GROQ_API_KEY,
} = process.env;

if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY ausente");
if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE)
  throw new Error("Evolution API creds ausentes (EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE)");

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const sessions = new Map();

const HOT_LEAD_PATTERNS = [
  /como (contratar|assinar|começar|ativar)/i,
  /quero (fechar|contratar|assinar|começar)/i,
  /vou (fechar|contratar|assinar)/i,
  /me (manda|passa|envia) (o link|o pix|o contrato|o pagamento)/i,
  /falar com (alguém|o responsável|o dono|um humano|vocês)/i,
  /como (eu )?(faço|faz) para (contratar|assinar|começar)/i,
];

const PRICE_PATTERNS = [
  /qual (é |o )?o? ?preço/i,
  /quanto (custa|é|fica)/i,
  /valor/i,
  /plano/i,
  /mensalidade/i,
];

function isHotLead(session, currentMessage) {
  const allMessages = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);

  if (HOT_LEAD_PATTERNS.some((p) => p.test(currentMessage))) return true;

  const priceHits = [...allMessages, currentMessage].filter((m) =>
    PRICE_PATTERNS.some((p) => p.test(m))
  ).length;
  return priceHits >= 2;
}

async function notifyOwner(phone, lastMessage) {
  if (!OWNER_PHONE) return;
  const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const msg =
    `🔥 *Lead quente no SmAIle!*\n\n` +
    `👤 Número: ${phone}\n` +
    `💬 Último interesse: ${lastMessage.slice(0, 200)}\n` +
    `⏰ Agora: ${now}\n\n` +
    `Entre na conversa agora! 🚀`;
  try {
    await sendText(OWNER_PHONE, msg);
    console.log(`🔥 Owner notificado sobre lead quente: ${phone}`);
  } catch (err) {
    console.error("❌ Falha ao notificar owner:", err.message);
  }
}

function loadPrompt() {
  const raw = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf-8").trim();
  if (!raw) return "Você é um atendente virtual amigável. Responda de forma curta e natural em português brasileiro.";
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key) => process.env[key] ?? `{{${key}}}`);
}
const SYSTEM_PROMPT = loadPrompt();

async function transcribeAudio(audioUrl) {
  if (!groq) throw new Error("GROQ_API_KEY não configurada");
  const resp = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Download de áudio falhou: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const file = new File([buffer], "audio.ogg", { type: "audio/ogg" });
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
    language: "pt",
  });
  return transcription.text;
}

async function sendText(phone, message) {
  const resp = await fetch(
    `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, textMessage: { text: message } }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Evolution API ${resp.status}: ${txt.slice(0, 300)}`);
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
    const data = (req.body || {}).data || {};
    const key = data.key || {};

    if (key.fromMe === true) return;

    const remoteJid = key.remoteJid || "";
    if (remoteJid.includes("@g.us")) return;

    const phone = remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
    if (!phone) return;

    const msg = data.message || {};
    const messageType = Object.keys(msg)[0] || "";
    const isAudio = /audioMessage|pttMessage/i.test(messageType);

    let text;
    if (isAudio) {
      const audioUrl = msg[messageType]?.url || null;
      if (!audioUrl) return;
      try {
        text = await transcribeAudio(audioUrl);
        console.log(`🎙️ ${phone} transcrito: ${text}`);
      } catch (err) {
        console.error("❌ Transcrição falhou:", err.message);
        await sendText(phone, "Desculpe, não consegui ouvir seu áudio 😊 Pode digitar sua mensagem?");
        return;
      }
    } else {
      text = msg.conversation || msg.extendedTextMessage?.text || "";
    }

    if (!text) return;

    console.log(`📩 ${phone}: ${text}`);

    if (!sessions.has(phone)) sessions.set(phone, { messages: [] });
    const session = sessions.get(phone);

    const hot = isHotLead(session, text);
    const reply = await getReply(session, text);
    console.log(`💬 ${phone}: ${reply}`);
    await sendText(phone, reply);
    console.log(`✅ ${phone} entregue`);
    if (hot && !session.ownerNotified) {
      session.ownerNotified = true;
      await notifyOwner(phone, text);
    }
  } catch (err) {
    console.error("❌", err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 odontozap rodando na :${PORT}`));
