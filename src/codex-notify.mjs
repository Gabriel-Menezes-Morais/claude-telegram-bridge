// Codex CLI -> Telegram. O Codex chama este programa com UM argumento JSON
// (config.toml: notify = ["node", "<este arquivo>"]), diferente do Claude Code,
// que manda o evento por stdin.
// Eventos conhecidos: agent-turn-complete.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir().split(String.fromCharCode(92)).join("/");
const CONFIG = process.env.CLAUDE_TG_CONFIG || `${HOME}/.claude/telegram.json`;
const SURFACES = `${HOME}/.claude/telegram-surfaces.json`;
const LOG = `${HOME}/.claude/telegram-hook.log`;
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} [codex] ${m}\n`); } catch {} };

// Registra o pane e devolve o rodape que permite responder de volta.
const surfaceMark = (label) => {
  const full = process.env.WMUX_SURFACE_ID || "";
  if (!full) return "";
  const short = full.replace(/^surf-/, "").slice(0, 8);
  try {
    const map = existsSync(SURFACES) ? JSON.parse(readFileSync(SURFACES, "utf8")) : {};
    map[short] = { ...(map[short] || {}), surface: full, label, agent: "codex", at: Date.now() };
    map.__last = short;
    writeFileSync(SURFACES, JSON.stringify(map, null, 2));
  } catch {}
  return `\n\nResponda esta mensagem para falar com este terminal [s:${short}]`;
};

try {
  const payload = JSON.parse(process.argv[2] || "{}");
  const type = payload.type || "?";
  log(`evento=${type}`);
  if (type !== "agent-turn-complete") process.exit(0);

  if (!existsSync(CONFIG)) process.exit(0);
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (!cfg.botToken || !cfg.chatId) process.exit(0);

  const label = (process.cwd().split(/[\/]/).filter(Boolean).pop() || "codex");
  const body = (payload["last-assistant-message"] || "(turno terminou sem texto)").trim();
  const asked = (payload["input-messages"] || []).join(" ").slice(0, 80);

  const fetchRetry = async (url, opts, tries = 4) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) }); } catch (e) { last = e; log(`rede falhou (${i + 1}/${tries}): ${e.cause?.code || e.message}`); }
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
    throw last;
  };

  const text = `🤖 codex · ${label}${asked ? `\n↳ ${asked}` : ""}\n\n${body}${surfaceMark(label)}`;
  const r = await fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, text: text.slice(0, 3800), disable_web_page_preview: true }),
  });
  log(`telegram http ${r.status}`);
} catch (e) {
  log(`erro: ${e?.message}`);
}
process.exit(0);
