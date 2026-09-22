// Envia status dos terminais Claude Code para o Telegram.
// Config: ~/.claude/telegram.json -> { botToken, chatId, minTurnSeconds }
// Log:    ~/.claude/telegram-hook.log
// Mapa de panes: ~/.claude/telegram-surfaces.json (lido pelo telegram-bridge.mjs)
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { connect } from "node:net";


const HOME = homedir().split(String.fromCharCode(92)).join("/");
const CONFIG = process.env.CLAUDE_TG_CONFIG || `${HOME}/.claude/telegram.json`;
const LOG = `${HOME}/.claude/telegram-hook.log`;
const SURFACES = `${HOME}/.claude/telegram-surfaces.json`;
const STATE = join(process.env.TEMP || process.env.TMPDIR || "/tmp", "claude-tg-state");
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

const lastAssistantText = (path) => {
  if (!path || !existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const content = e?.message?.content;
    if (e?.type !== "assistant" || !Array.isArray(content)) continue;
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) return text;
  }
  return "";
};

// Registra o pane wmux deste terminal e devolve o rodape que permite responder.
const surfaceMark = (label, lastMsg, cwd, sessionId) => {
  const full = process.env.WMUX_SURFACE_ID || "";
  if (!full) return "";
  const short = full.replace(/^surf-/, "").slice(0, 8);
  try {
    const map = existsSync(SURFACES) ? JSON.parse(readFileSync(SURFACES, "utf8")) : {};
    map[short] = { ...(map[short] || {}), surface: full, label, agent: "claude", cwd: cwd || undefined, sessionId: sessionId || undefined, at: Date.now(), lastMsg: String(lastMsg || "").slice(0, 160) };
    map.__last = short;
    writeFileSync(SURFACES, JSON.stringify(map, null, 2));
  } catch {}
  return `\n\nResponda esta mensagem para falar com este terminal [s:${short}]`;
};

// A primeira conexao nesta rede costuma estourar; falhar rapido e repetir
// chega antes de esperar o timeout longo do undici.
const fetchRetry = async (url, opts, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) }); }
    catch (e) { last = e; log(`rede falhou (${i + 1}/${tries}): ${e.cause?.code || e.name}`); }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw last;
};


// A ponte viva mantem a trava na 49787. Sem ela, a notificacao ainda chega,
// mas resposta sua nao volta — e voce so descobriria tentando.
const pontePerto = () => new Promise((res) => {
  const s = connect({ port: 49787, host: "127.0.0.1" });
  const fim = (v) => { try { s.destroy(); } catch {} res(v); };
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
  return `

[!] Ponte offline${desde}: sua resposta NAO vai chegar. Rode: node "${HOME}/.claude/hooks/telegram-bridge.mjs"`;
};

const send = async (token, chatId, text, keyboard) => {
  const r = await fetchRetry(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 3800),
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
  });
  log(`telegram http ${r.status}`);
};

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const event = input.hook_event_name || "?";
  log(`entrou evento=${event} cwd=${input.cwd || "?"}`);

  if (!existsSync(CONFIG)) { log("sem config"); process.exit(0); }
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (!cfg.botToken || !cfg.chatId) { log("config incompleto"); process.exit(0); }
  const minTurn = cfg.minTurnSeconds ?? 15;

  const sid = String(input.session_id || "sem-id");
  const label = basename(input.cwd || "?");
  const tag = `${label} · ${sid.slice(0, 6)}`;
  mkdirSync(STATE, { recursive: true });
  const stamp = join(STATE, `${sid}.txt`);

  if (event === "UserPromptSubmit") { writeFileSync(stamp, String(Date.now())); process.exit(0); }

  if (event === "Notification") {
    const short = (process.env.WMUX_SURFACE_ID || "").replace(/^surf-/, "").slice(0, 8);
    const msg = input.message || "precisa de voce";
    // "esperando voce digitar" nao e pedido de permissao: notificar isso
    // transforma silencio em alarme, e os botoes Sim/Nao nem se aplicam.
    if (/waiting for your input|is waiting|esperando/i.test(msg)) { log(`pulou ocioso: ${msg.slice(0, 60)}`); process.exit(0); }
    // Botao so faz sentido com pane conhecido: o callback precisa do id.
    const keyboard = short ? [[
      { text: "Sim", callback_data: `k:${short}:1` },
      { text: "Sim, sempre", callback_data: `k:${short}:2` },
      { text: "Nao", callback_data: `k:${short}:esc` },
    ]] : null;
    await send(cfg.botToken, cfg.chatId, `🔔 ${tag}\n${msg}${surfaceMark(label, msg, input.cwd, input.session_id)}${await avisoPonte()}`, keyboard);
    process.exit(0);
  }

  if (event === "Stop") {
    const started = existsSync(stamp) ? Number(readFileSync(stamp, "utf8")) : 0;
    const elapsed = started ? (Date.now() - started) / 1000 : Infinity;
    // Se o turno veio do celular, a resposta volta para la mesmo sendo curta.
    const short = (process.env.WMUX_SURFACE_ID || "").replace(/^surf-/, "").slice(0, 8);
    const phone = short ? join(STATE, `phone-${short}.txt`) : "";
    const fromPhone = phone && existsSync(phone);
    if (fromPhone) { try { rmSync(phone); } catch {} }
    if (!fromPhone && elapsed < minTurn) { log(`pulou: ${Math.round(elapsed)}s < ${minTurn}s`); process.exit(0); }
    const body = lastAssistantText(input.transcript_path) || "(turno terminou sem texto)";
    const secs = Number.isFinite(elapsed) ? ` · ${Math.round(elapsed)}s` : "";
    await send(cfg.botToken, cfg.chatId, `✅ ${tag}${secs}\n\n${body}${surfaceMark(label, body, input.cwd, input.session_id)}${await avisoPonte()}`);
  }
} catch (e) {
  log(`erro: ${e?.message}`);
}
process.exit(0);
