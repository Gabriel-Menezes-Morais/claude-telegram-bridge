// uso: node telegram-setup.mjs <botToken>
// Pega o chat_id da ultima mensagem enviada ao bot, grava o config e manda um teste.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
const token = process.argv[2];
if (!token) { console.error("uso: node telegram-setup.mjs <botToken>"); process.exit(1); }
const r = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
if (!r.ok) { console.error("token invalido:", r.description); process.exit(1); }
const chatId = [...r.result].reverse().map(u => u.message?.chat?.id ?? u.channel_post?.chat?.id).find(Boolean);
if (!chatId) { console.error("Nenhuma mensagem encontrada. Mande /start para o bot no Telegram e rode de novo."); process.exit(1); }
const HOME = homedir().split(String.fromCharCode(92)).join("/");
const CONFIG = process.env.CLAUDE_TG_CONFIG || `${HOME}/.claude/telegram.json`;
// Preserva o que ja estava configurado (requireTarget, chave de transcricao, raizes).
let prev = {};
try { if (existsSync(CONFIG)) prev = JSON.parse(readFileSync(CONFIG, "utf8")); } catch {}
const cfg = { minTurnSeconds: 15, requireTarget: true, ...prev, botToken: token, chatId: String(chatId) };
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text: "✅ Claude Code conectado. Vou avisar aqui quando um terminal terminar ou precisar de voce." }),
});
console.log("configurado. chat_id =", chatId);
