const express = require("express");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const Anthropic = require("@anthropic-ai/sdk");
const Groq = require("groq-sdk");
require("dotenv").config();

const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  OWNER_PHONE,
  GROQ_API_KEY,
  WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
} = process.env;

if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY ausente");

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

function loadPrompt() {
  const raw = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf-8").trim();
  if (!raw) return "Você é um atendente virtual amigável. Responda de forma curta e natural em português brasileiro.";
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key) => process.env[key] ?? `{{${key}}}`);
}
const SYSTEM_PROMPT = loadPrompt();

let waSocket = null;
let currentQR = null;

function toJid(phone) {
  if (!phone) return null;
  const num = String(phone).replace(/\D/g, "");
  return num.includes("@") ? phone : `${num}@s.whatsapp.net`;
}

async function sendText(jid, message) {
  if (!waSocket) throw new Error("WhatsApp não conectado");
  await waSocket.sendMessage(jid, { text: message });
}

async function notifyOwner(jid, lastMessage) {
  if (!OWNER_PHONE) return;
  const ownerJid = toJid(OWNER_PHONE);
  if (!ownerJid) return;
  const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const msg =
    `🔥 *Lead quente no SmAIle!*\n\n` +
    `👤 Número: ${jid}\n` +
    `💬 Último interesse: ${lastMessage.slice(0, 200)}\n` +
    `⏰ Agora: ${now}\n\n` +
    `Entre na conversa agora! 🚀`;
  try {
    await sendText(ownerJid, msg);
    console.log(`🔥 Owner notificado sobre lead quente: ${jid}`);
  } catch (err) {
    console.error("❌ Falha ao notificar owner:", err.message);
  }
}

async function transcribeAudio(audioBuffer) {
  if (!groq) throw new Error("GROQ_API_KEY não configurada");
  const file = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
    language: "pt",
  });
  return transcription.text;
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

async function handleIncomingMessage(msg) {
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid || "";
  if (jid.endsWith("@g.us")) return;

  const msgContent = msg.message || {};
  const isAudio = !!(msgContent.audioMessage || msgContent.pttMessage);

  let text;
  if (isAudio) {
    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      text = await transcribeAudio(buffer);
      console.log(`🎙️ ${jid} transcrito: ${text}`);
    } catch (err) {
      console.error("❌ Transcrição falhou:", err.message);
      await sendText(jid, "Desculpe, não consegui ouvir seu áudio 😊 Pode digitar sua mensagem?");
      return;
    }
  } else {
    text = msgContent.conversation || msgContent.extendedTextMessage?.text || "";
  }

  if (!text) return;
  await processMessage(jid, text);
}

async function processMessage(jid, text) {
  console.log(`📩 ${jid}: ${text}`);

  if (!sessions.has(jid)) sessions.set(jid, { messages: [] });
  const session = sessions.get(jid);

  const hot = isHotLead(session, text);
  const reply = await getReply(session, text);
  console.log(`💬 ${jid}: ${reply}`);
  await sendText(jid, reply);
  console.log(`✅ ${jid} entregue`);
  if (hot && !session.ownerNotified) {
    session.ownerNotified = true;
    await notifyOwner(jid, text);
  }
}

async function startBaileys() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
  } = await import("@whiskeysockets/baileys");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: true,
  });

  waSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("📱 QR Code disponível em /qrcode");
    }
    if (connection === "close") {
      currentQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconectando...");
        startBaileys();
      } else {
        console.log("❌ Deslogado. Escaneie o QR novamente em /qrcode");
        startBaileys();
      }
    } else if (connection === "open") {
      currentQR = null;
      console.log("✅ WhatsApp conectado");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        console.error("❌", err.message);
      }
    }
  });
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) =>
  res.json({ status: "ok", sessions: sessions.size, model: ANTHROPIC_MODEL, connected: !!waSocket })
);

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN)
    return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    const phone = message.from;
    if (!phone) return;

    const jid = `${phone}@s.whatsapp.net`;
    const isAudio = message.type === "audio";

    let text;
    if (isAudio) {
      if (!WHATSAPP_TOKEN) {
        await handleMetaReply(jid, "Desculpe, não consigo ouvir áudios agora 😊 Pode digitar sua mensagem?");
        return;
      }
      try {
        const mediaId = message.audio.id;
        const metaResp = await fetch(
          `https://graph.facebook.com/v19.0/${mediaId}`,
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
        const { url } = await metaResp.json();
        const audioResp = await fetch(url, {
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
          signal: AbortSignal.timeout(30_000),
        });
        const buffer = Buffer.from(await audioResp.arrayBuffer());
        text = await transcribeAudio(buffer);
        console.log(`🎙️ ${jid} transcrito: ${text}`);
      } catch (err) {
        console.error("❌ Transcrição Meta falhou:", err.message);
        await handleMetaReply(jid, "Desculpe, não consegui ouvir seu áudio 😊 Pode digitar sua mensagem?");
        return;
      }
    } else {
      text = message.text?.body || "";
    }

    if (!text) return;
    await processMessage(jid, text);
  } catch (err) {
    console.error("❌", err.message);
  }
});

app.get("/qrcode", (_req, res) => {
  if (!currentQR)
    return res.status(404).send("QR não disponível — já conectado ou aguardando geração");
  res.send(`<!DOCTYPE html><html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${currentQR}" /></body></html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 odontozap rodando na :${PORT}`);
  startBaileys();
});
