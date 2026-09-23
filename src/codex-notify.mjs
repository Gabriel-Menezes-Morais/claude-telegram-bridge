// Codex CLI -> Telegram. O Codex chama este programa com UM argumento JSON
// (config.toml: notify = ["node", "<este arquivo>"]), diferente do Claude Code,
// que manda o evento por stdin. Evento usado: agent-turn-complete.
//
// Esta hook NAO chama process.exit: encerrar a forca enquanto o undici desmonta
// o socket derruba o processo com assercao do libuv (UV_HANDLE_CLOSING).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { connect } from "node:net";

const HOME = homedir().split(String.fromCharCode(92)).join("/");
const CONFIG = process.env.CLAUDE_TG_CONFIG || `${HOME}/.claude/telegram.json`;
const SURFACES = `${HOME}/.claude/telegram-surfaces.json`;
const LOG = `${HOME}/.claude/telegram-hook.log`;
const NL = String.fromCharCode(10);
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} [codex] ${m}${NL}`); } catch {} };

// Nome da pasta, com barra normal ou invertida.
const nomeDaPasta = (p) => String(p).split(String.fromCharCode(92)).join("/").split("/").filter(Boolean).pop();

const surfaceMark = (label, cwd, lastMsg) => {
  const full = process.env.WMUX_SURFACE_ID || "";
  if (!full) return "";
  const short = full.replace(/^surf-/, "").slice(0, 8);
  try {
    const map = existsSync(SURFACES) ? JSON.parse(readFileSync(SURFACES, "utf8")) : {};
    map[short] = {
      ...(map[short] || {}),
      surface: full,
      label,
      agent: "codex",
      cwd: cwd || undefined,
      at: Date.now(),
      lastMsg: String(lastMsg || "").slice(0, 160),
    };
    map.__last = short;
    writeFileSync(SURFACES, JSON.stringify(map, null, 2));
  } catch {}
  return `${NL}${NL}Responda esta mensagem para falar com este terminal [s:${short}]`;
};

// A ponte viva mantem a trava na 49787. Sem ela a notificacao chega, mas a
// resposta do celular nao volta.
const pontePerto = () => new Promise((res) => {
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
  let desde = "";
  try {
    const hb = `${HOME}/.claude/telegram-bridge.heartbeat`;
    if (existsSync(hb)) {
      const min = Math.round((Date.now() - Number(readFileSync(hb, "utf8"))) / 60000);
      desde = min > 0 ? ` (ha ${min}min)` : "";
    }
  } catch {}
  return `${NL}${NL}[!] Ponte offline${desde}: sua resposta NAO vai chegar. Rode: node "${HOME}/.claude/hooks/telegram-bridge.mjs"`;
};

const fetchRetry = async (url, opts, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try { return await fetch(url, { ...opts, signal: ac.signal }); }
    catch (e) { last = e; log(`rede falhou (${i + 1}/${tries}): ${e.cause?.code || e.name}`); }
    finally { clearTimeout(t); }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw last;
};

// O Telegram aceita 4096 caracteres por mensagem: quebramos em partes em vez de
// cortar, preferindo linha em branco e depois quebra de linha.
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

const main = async () => {
  const payload = JSON.parse(process.argv[2] || "{}");
  const type = payload.type || "?";
  log(`evento=${type}`);
  if (type !== "agent-turn-complete") return;

  if (!existsSync(CONFIG)) { log("sem config"); return; }
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (!cfg.botToken || !cfg.chatId) { log("config incompleto"); return; }

  const cwd = process.cwd();
  const label = nomeDaPasta(cwd) || "codex";
  const body = (payload["last-assistant-message"] || "(turno terminou sem texto)").trim();
  const asked = (payload["input-messages"] || []).join(" ").slice(0, 80);

  const cabeca = `🤖 codex · ${label}${asked ? `${NL}↳ ${asked}` : ""}`;
  const texto = `${cabeca}${NL}${NL}${body}${surfaceMark(label, cwd, body)}${await avisoPonte()}`;

  const partes = partir(texto);
  for (let i = 0; i < partes.length; i++) {
    const marca = partes.length > 1 ? `(${i + 1}/${partes.length})${NL}` : "";
    const r = await fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: (marca + partes[i]).slice(0, 4096),
        disable_web_page_preview: true,
      }),
    });
    // Consumir o corpo devolve o socket ao undici em vez de deixa-lo preso.
    try { await r.text(); } catch {}
    log(`telegram http ${r.status} (parte ${i + 1}/${partes.length})`);
  }
};

try {
  await main();
} catch (e) {
  log(`erro: ${e?.message}`);
}
