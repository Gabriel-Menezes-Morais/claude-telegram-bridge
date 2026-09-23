// OpenCode -> Telegram. Plugin de evento: nao existe hook de processo como no
// Claude Code, nem `notify` como no Codex, mas o plugin recebe o fluxo de
// eventos da sessao.
// Instalado em ~/.config/opencode/plugin/telegram.js
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";

const HOME = homedir().split(String.fromCharCode(92)).join("/");
const CONFIG = process.env.CLAUDE_TG_CONFIG || `${HOME}/.claude/telegram.json`;
const SURFACES = `${HOME}/.claude/telegram-surfaces.json`;
const LOG = `${HOME}/.claude/telegram-hook.log`;
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} [opencode] ${m}\n`); } catch {} };

const loadCfg = () => {
  try { return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : null; } catch { return null; }
};

// Registra o pane e devolve o rodape que permite responder de volta.
const surfaceMark = (label, cwd, lastMsg, sessionId) => {
  const full = process.env.WMUX_SURFACE_ID || "";
  if (!full) return "";
  const short = full.replace(/^surf-/, "").slice(0, 8);
  try {
    const map = existsSync(SURFACES) ? JSON.parse(readFileSync(SURFACES, "utf8")) : {};
    map[short] = { ...(map[short] || {}), surface: full, label, agent: "opencode", cwd: cwd || undefined, sessionId: sessionId || undefined, at: Date.now(), lastMsg: String(lastMsg || "").slice(0, 160) };
    map.__last = short;
    writeFileSync(SURFACES, JSON.stringify(map, null, 2));
  } catch {}
  return `\n\nResponda esta mensagem para falar com este terminal [s:${short}]`;
};


// A ponte viva mantem a trava na 49787. Sem ela a notificacao chega, mas a
// resposta do celular nao volta.
const pontePerto = () => new Promise((res) => {
  // O guarda importa: sem ele, connect e timeout podem destruir o mesmo socket
  // duas vezes, e o libuv aborta o processo na saida (UV_HANDLE_CLOSING).
  let pronto = false;
  const s = connect({ port: 49787, host: "127.0.0.1" });
  s.unref();
  const fim = (v) => { if (pronto) return; pronto = true; try { s.destroy(); } catch {} res(v); };
  s.setTimeout(800);
  s.once("connect", () => fim(true));
  s.once("timeout", () => fim(false));
  s.once("error", () => fim(false));
});

const avisoPonte = async () => {
  if (await pontePerto()) return "";
  return `

[!] Ponte offline: sua resposta NAO vai chegar. Rode: node "${HOME}/.claude/hooks/telegram-bridge.mjs"`;
};

// O Telegram aceita 4096 caracteres por mensagem. Quebramos em partes em vez de
// cortar, preferindo linha em branco e depois quebra de linha.
const NL = String.fromCharCode(10);
const partir = (texto, limite = 3900) => {
  if (texto.length <= limite) return [texto];
  const partes = [];
  let resto = texto;
  while (resto.length > limite) {
    const janela = resto.slice(0, limite);
    let corte = janela.lastIndexOf(NL + NL);
    if (corte < limite * 0.5) corte = janela.lastIndexOf(NL);
    if (corte < limite * 0.5) corte = limite;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
    while (resto.startsWith(NL)) resto = resto.slice(1);
  }
  if (resto.trim()) partes.push(resto);
  return partes;
};

const send = async (texto) => {
  const partes = partir(texto);
  for (let i = 0; i < partes.length; i++) {
    const marca = partes.length > 1 ? `(${i + 1}/${partes.length})${NL}` : "";
    await enviarUm(marca + partes[i]);
  }
};

const enviarUm = async (text) => {
  const cfg = loadCfg();
  if (!cfg?.botToken || !cfg?.chatId) return;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
      });
      // Consumir o corpo devolve o socket ao undici, em vez de deixa-lo preso.
      try { await r.text(); } catch {}
      log(`telegram http ${r.status}`);
      return;
    } catch (e) {
      log(`rede falhou (${i + 1}/3): ${e.cause?.code || e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
};

export const TelegramPlugin = async ({ directory }) => {
  const label = String(directory || process.cwd()).split(String.fromCharCode(92)).join("/").split("/").filter(Boolean).pop() || "opencode";
  // Parte de texto nao diz o papel; message.updated diz. Sem esse cruzamento a
  // ponte mandaria de volta o que voce mesmo digitou.
  const assistantMsgs = new Set();
  const lastText = new Map();
  log(`plugin carregado em ${label}`);

  return {
    event: async ({ event }) => {
      const type = event?.type;
      if (!type) return;

      if (type === "message.updated") {
        const info = event.properties?.info;
        if (info?.role === "assistant" && info?.id) assistantMsgs.add(info.id);
        return;
      }

      if (type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.type === "text" && part.text && !part.synthetic && assistantMsgs.has(part.messageID)) {
          lastText.set(part.sessionID, part.text);
        }
        return;
      }

      if (type === "session.idle") {
        const id = event.properties?.sessionID;
        const body = (lastText.get(id) || "").trim();
        lastText.delete(id);
        if (!body) return;
        await send(`🟠 opencode · ${label}\n\n${body}${surfaceMark(label, directory, body, id)}${await avisoPonte()}`);
        return;
      }

      if (type === "permission.updated") {
        const p = event.properties || {};
        const what = p.title || p.type || "precisa de voce";
        await send(`🔔 opencode · ${label}\n${what}${surfaceMark(label, directory, what, p.sessionID)}${await avisoPonte()}`);
      }
    },
  };
};
