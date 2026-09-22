// Ponte de volta: le as suas respostas no Telegram e digita no terminal wmux certo.
// Roda como daemon. Config e logs ficam em ~/.claude/.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFile } from "node:child_process";
import { createServer } from "node:net";

const HOME = homedir().split(String.fromCharCode(92)).join("/");
const CONFIG = process.env.CLAUDE_TG_CONFIG || `${HOME}/.claude/telegram.json`;
const SURFACES = `${HOME}/.claude/telegram-surfaces.json`;
const OFFSET = `${HOME}/.claude/telegram-bridge.offset`;
const LOG = `${HOME}/.claude/telegram-bridge.log`;
const STATE = join(tmpdir(), "claude-tg-state");
// Node 24 no Windows recusa spawn de .cmd, entao chamamos o wmux.js direto.

// Onde esta o CLI do wmux. Ordem: config, variavel que o proprio wmux injeta,
// caminho padrao da instalacao.
function cfgWmux() {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    if (c.wmuxCli && existsSync(c.wmuxCli)) return c.wmuxCli;
  } catch {}
  if (process.env.WMUX_CLI && existsSync(process.env.WMUX_CLI)) return process.env.WMUX_CLI;
  return `${HOME}/wmux/app/resources/cli/wmux.js`;
}

const WMUX_JS = cfgWmux();

const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
let cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
// Relido a cada mensagem: mudar requireTarget/minTurnSeconds nao exige reiniciar.
const reloadCfg = () => { try { cfg = JSON.parse(readFileSync(CONFIG, "utf8")); } catch {} };

// Wi-Fi oscila: uma falha de rede nao pode engolir um audio em silencio.
const fetchRetry = async (url, opts = {}, tries = 3) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts); } catch (e) { last = e; log(`rede falhou (${i + 1}/${tries}): ${e.cause?.code || e.message}`); }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw last;
};

const api = (m, body) => fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/${m}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

const reply = async (text) => {
  const r = await api("sendMessage", { chat_id: cfg.chatId, text: text.slice(0, 3800) });
  log(r?.ok ? `reply enviado msg_id=${r.result?.message_id}: ${text.slice(0, 60)}` : `reply falhou: ${r?.description || "sem resposta"}`);
  return r;
};

const wmux = (args) => new Promise((res) => {
  execFile(process.execPath, [WMUX_JS, ...args], { windowsHide: true }, (err, out, errOut) => {
    if (err) log(`wmux erro ${args[0]}: ${errOut || err.message}`);
    res(String(out || ""));
  });
});


const SURFACES_W = SURFACES;
const readScreen = async (surface) => {
  const out = await wmux(["read-screen", "--surface", surface, "--lines", "20"]);
  try { return JSON.parse(out).text || ""; } catch { return ""; }
};

// Espera o Claude do pane novo ficar pronto, respondendo o "trust this folder".
const waitReady = async (surface, seconds = 90) => {
  for (let i = 0; i < seconds / 2; i++) {
    const screen = await readScreen(surface);
    if (/trust this folder/i.test(screen)) {
      await wmux(["send-key", "down", "--surface", surface]);
      await new Promise((r) => setTimeout(r, 500));
      await wmux(["send-key", "enter", "--surface", surface]);
      log(`pasta confirmada em ${surface}`);
    } else if (/shift\+tab to cycle|❯ Try "/.test(screen)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

const registerSurface = (surface, label, agentId, agent = "claude") => {
  const short = surface.replace(/^surf-/, "").slice(0, 8);
  try {
    const map = existsSync(SURFACES_W) ? JSON.parse(readFileSync(SURFACES_W, "utf8")) : {};
    map[short] = { surface, label, agentId, agent, at: Date.now() };
    writeFileSync(SURFACES_W, JSON.stringify(map, null, 2));
  } catch {}
  return short;
};

// /novo [pasta] | tarefa  -> abre um terminal Claude novo e ja manda a tarefa
const spawnAgent = async (arg, cli = "claude") => {
  const [rawCwd, ...rest] = arg.split("|");
  const task = rest.join("|").trim();
  if (!task) { await reply("Use: /novo <pasta ou apelido> | <tarefa>" + String.fromCharCode(10) + "Ex: /novo hunter | rode os testes" + String.fromCharCode(10) + "/pastas mostra os apelidos."); return; }

  const dir = resolveDir(task ? rawCwd : "");
  if (dir.none) { await reply(`Nao achei pasta "${dir.none}". Mande /pastas <parte do nome> para ver as opcoes.`); return; }
  if (dir.options) {
    await reply(["Varias pastas combinam. Repita com o nome exato:", ...dir.options.map((d) => `  ${d.name}`)].join(String.fromCharCode(10)));
    return;
  }
  const cwd = dir.full;

  const out = await wmux(["agent", "spawn", "--cmd", cli, "--cwd", cwd, "--label", cwd.split(/[\/]/).filter(Boolean).pop() || cli]);
  let ids;
  try { ids = JSON.parse(out); } catch { await reply(`Nao consegui abrir o terminal em ${cwd}.`); return; }

  const label = cwd.split(/[\/]/).filter(Boolean).pop() || "claude";
  const short = registerSurface(ids.surfaceId, label, ids.agentId, cli);
  await reply(`Abrindo ${cli} em ${label} [s:${short}]. Mando a tarefa quando ele subir.`);

  if (cli === "claude") {
    const ready = await waitReady(ids.surfaceId);
    if (!ready) { await reply(`O terminal [s:${short}] demorou a subir. Mande a tarefa na mao com s:${short} <texto>.`); return; }
  } else {
    // O read-screen do wmux volta vazio na TUI do Codex, entao nao da para
    // detectar "pronto": espera fixa, ajustavel em bootSeconds.
    await new Promise((r) => setTimeout(r, (cfg.bootSeconds ?? 15) * 1000));
  }

  await wmux(["send", "--surface", ids.surfaceId, task]);
  await new Promise((r) => setTimeout(r, 400));
  await wmux(["send-key", "enter", "--surface", ids.surfaceId]);
  log(`novo agente ${label} [${short}]: ${task.slice(0, 80)}`);
  await reply(`Tarefa enviada para ${label} [s:${short}].`);
};

const HELP = [
  "Comandos:",
  "/panes  - lista os terminais e ids",
  "/pastas [filtro]  - lista os apelidos de pasta",
  "/novo <apelido> | <tarefa>  - abre um Claude novo ja com a tarefa",
  "/codex <apelido> | <tarefa>  - o mesmo, com o Codex",
  "/scan  - registra panes abertos na mao",
  "/nome s:<id> <apelido>  - da um nome falavel ao terminal",
  "/matar s:<id>  - encerra aquele terminal",
  "",
  "Para falar com um terminal: responda a notificacao dele,",
  "ou use  s:<id> texto  ou  @pasta texto",
].join(String.fromCharCode(10));


// Voce nao decora caminho: o bot resolve apelido -> pasta.
// Onde procurar projetos quando voce diz so o apelido da pasta.
// Sobrescreva com "projectRoots": [{ "dir": "...", "deep": true }] no config.
const DEFAULT_ROOTS = [
  { dir: `${HOME}/Documents`, deep: true },
  { dir: `${HOME}/Desktop`, deep: false },
  { dir: `${HOME}/projects`, deep: true },
  { dir: HOME, deep: false },
];
const ROOTS = (() => {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    if (Array.isArray(c.projectRoots) && c.projectRoots.length) {
      return c.projectRoots.map((r) => (typeof r === "string" ? { dir: r, deep: true } : r));
    }
  } catch {}
  return DEFAULT_ROOTS;
})();
const SKIP = /^(AppData|OneDrive|node_modules|\.git|Meus |Minhas |Ambiente |Dados de|Configura|Menu |Modelos|Recent|SendTo|Searches|Links|Cookies|Favorites|Contacts|Saved Games|Music|Pictures|Videos|Downloads)/i;

// Varre as pastas conhecidas (nivel 1, e nivel 2 onde faz sentido) e poe
// repositorio git na frente, que e o que ele costuma querer abrir.
const projectDirs = () => {
  const found = [];
  const push = (root, name, full) => {
    if (found.some((f) => f.full.toLowerCase() === full.toLowerCase())) return null;
    let mtime = 0;
    try { mtime = statSync(full).mtimeMs; } catch {}
    const isRepo = existsSync(`${full}/.git`);
    const entry = { name, full, mtime, isRepo, root };
    found.push(entry);
    return entry;
  };
  for (const { dir, deep } of ROOTS) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.test(e.name)) continue;
      const full = `${dir}/${e.name}`;
      const added = push(dir, e.name, full);
      if (!deep || (added && added.isRepo)) continue;
      let kids = [];
      try { kids = readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const k of kids) {
        if (!k.isDirectory() || k.name.startsWith(".") || SKIP.test(k.name)) continue;
        push(full, k.name, `${full}/${k.name}`);
      }
    }
  }
  return found.sort((a, b) => (b.isRepo - a.isRepo) || (b.mtime - a.mtime));
};

// Aceita caminho completo, ou apelido. Devolve {full} ou {options} ou {none}.
const resolveDir = (raw) => {
  const q = raw.trim().replace(/^["']|["']$/g, "");
  if (!q) return { full: HOME };
  if (/^[a-z]:/i.test(q)) { const full = q.split(String.fromCharCode(92)).join("/"); return existsSync(full) ? { full } : { none: q }; }
  const dirs = projectDirs();
  const low = q.toLowerCase();
  const exact = dirs.filter((d) => d.name.toLowerCase() === low);
  const partial = exact.length ? exact : dirs.filter((d) => d.name.toLowerCase().includes(low));
  if (partial.length === 1) return { full: partial[0].full };
  if (partial.length > 1) return { options: partial.slice(0, 12) };
  return { none: q };
};


// Audio do Telegram -> texto. Voce fala, o terminal recebe digitado.
const transcribe = async (fileId) => {
  if (!cfg.openaiKey) { log("sem openaiKey"); return null; }
  const info = await (await fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/getFile?file_id=${fileId}`)).json();
  if (!info.ok) { log(`getFile falhou: ${info.description}`); return null; }
  const audio = await fetchRetry(`https://api.telegram.org/file/bot${cfg.botToken}/${info.result.file_path}`);
  const blob = await audio.blob();

  const form = new FormData();
  form.append("file", blob, "audio.ogg");
  form.append("model", cfg.transcribeModel || "whisper-1");
  if (cfg.transcribeLang) form.append("language", cfg.transcribeLang);

  const r = await fetchRetry("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { authorization: `Bearer ${cfg.openaiKey}` }, body: form,
  });
  const j = await r.json();
  if (!r.ok) { log(`transcricao falhou: ${JSON.stringify(j).slice(0, 200)}`); return null; }
  return (j.text || "").trim();
};

const surfaces = () => { try { return JSON.parse(readFileSync(SURFACES, "utf8")); } catch { return {}; } };


const norm = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Distancia de edicao: o Whisper troca "claude" por "Cláudio", "backend" por "back end"
// "Randam". Comparacao exata perderia todos esses.
const dist = (a, b) => {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
};

// Quanto erro perdoar: nome curto exige quase exato, nome longo aceita mais.
const tolerance = (word) => (word.length <= 4 ? 0 : word.length <= 6 ? 2 : 3);

// Em audio ninguem fala "s:eb2ac583". O comeco da frase nomeia o terminal:
// "myapp, roda os testes" / "no backend ..." / "terminal front, ...".
const FILLERS = /^(manda|mande|envia|envie|fala|diz|no|na|pro|pra|para|o|a|terminal|pane|agente)\s+/i;
const matchSpoken = (text) => {
  const map = surfaces();
  const known = Object.entries(map).filter(([k]) => k !== "__last")
    .map(([key, v]) => ({ key, ...v, words: norm(v.alias || v.label).replace(/^[^a-z0-9]+/, "") }))
    .filter((k) => k.words);
  if (!known.length) return null;

  const original = text.replace(/^[,.\s]+/, "");
  let head = norm(original);
  let cut = original.length - head.length;
  for (let i = 0; i < 3; i++) {
    const before = head;
    head = head.replace(FILLERS, "");
    cut += before.length - head.length;
  }

  const tokens = head.split(/\s+/).filter(Boolean);
  let best = null;
  for (const k of known) {
    const nWords = k.words.split(/\s+/).length;
    for (let take = nWords; take <= nWords + 1 && take <= tokens.length; take++) {
      const candidate = tokens.slice(0, take).join(" ").replace(/[,.:;!?]+$/, "");
      const d = dist(candidate, k.words);
      if (d <= tolerance(k.words) && (!best || d < best.d)) {
        best = { d, k, consumed: tokens.slice(0, take).join(" ").length };
      }
    }
  }
  if (!best) return null;

  const body = original.slice(cut + best.consumed).replace(/^[,.:;!?\s]+/, "").trim();
  if (!body) return null;
  log(`audio roteado por nome "${best.k.words}" (erro ${best.d})`);
  return { key: best.k.key, surface: best.k.surface, label: best.k.alias || best.k.label, body };
};

// Tres formas de dizer para qual terminal vai, nesta ordem:
//   1. prefixo explicito no texto:  "s:ab12cd34 roda os testes"  ou  "@hunter roda os testes"
//   2. responder (reply) a notificacao daquele terminal
//   3. nenhuma das duas -> o ultimo terminal que notificou
const resolve = (update, text) => {
  const map = surfaces();
  const pick = (key) => (key && map[key] ? { key, body: null, ...map[key] } : null);

  const byId = text.match(/^\[?s:([0-9a-f]{4,8})\]?\s+([\s\S]+)$/i);
  if (byId) {
    const key = Object.keys(map).find((k) => k !== "__last" && k.startsWith(byId[1].toLowerCase()));
    const hit = pick(key);
    if (hit) return { ...hit, body: byId[2].trim() };
    return { missing: byId[1] };
  }

  const byLabel = text.match(/^@(\S+)\s+([\s\S]+)$/);
  if (byLabel) {
    const want = byLabel[1].toLowerCase();
    const key = Object.entries(map).filter(([k]) => k !== "__last")
      .sort((a, b) => b[1].at - a[1].at)
      .find(([, v]) => String(v.label).toLowerCase().includes(want))?.[0];
    const hit = pick(key);
    if (hit) return { ...hit, body: byLabel[2].trim() };
    return { missing: byLabel[1] };
  }

  const quoted = update.message?.reply_to_message?.text || "";
  const m = quoted.match(/\[s:([0-9a-f]{8})\]/);
  if (m) return pick(m[1]);

  const spokenHit = matchSpoken(text);
  if (spokenHit) return spokenHit;
  // Sem id e sem reply: cai no ultimo terminal que notificou, a menos que
  // telegram.json traga "requireTarget": true.
  if (cfg.requireTarget) return null;
  return pick(map.__last);
};

const handle = async (update) => {
  reloadCfg();
  log(`recebido: ${JSON.stringify(update.message?.text || "(sem texto)").slice(0, 120)}`);
  const msg = update.message;
  if (!msg) return;
  if (String(msg.chat?.id) !== String(cfg.chatId)) { log(`ignorado chat ${msg.chat?.id}`); return; }

  const voice = msg.voice || msg.audio || msg.video_note;
  let text = (msg.text || "").trim();
  if (!text && voice) {
    let heard = null;
    try { heard = await transcribe(voice.file_id); }
    catch (e) { log(`transcricao explodiu: ${e?.message}`); }
    if (!heard) { await reply("Nao consegui transcrever esse audio (rede ou transcricao falhou). Mande de novo."); return; }
    text = heard;
    await reply(`Ouvi: ${heard}`);
  }
  if (!text) return;

  if (/^\/nome/.test(text)) {
    const mm = text.replace(/^\/nome/, "").trim().match(/^\[?s:?([0-9a-f]{4,8})\]?\s+(.+)$/i);
    if (!mm) { await reply("Use: /nome s:<id> <apelido>   ex: /nome s:eb2ac583 principal"); return; }
    const map = surfaces();
    const key = Object.keys(map).find((k) => k !== "__last" && k.startsWith(mm[1].toLowerCase()));
    if (!key) { await reply(`Nao achei [s:${mm[1]}]. /panes lista os ids.`); return; }
    map[key].alias = mm[2].trim();
    try { writeFileSync(SURFACES, JSON.stringify(map, null, 2)); } catch {}
    await reply(`Agora esse terminal atende por "${mm[2].trim()}". Em audio, comece a frase com esse nome.`);
    return;
  }

  if (/^\/pastas/.test(text)) {
    const q = text.replace(/^\/pastas/, "").trim().toLowerCase();
    const hits = projectDirs().filter((d) => !q || d.name.toLowerCase().includes(q)).slice(0, 25);
    await reply(hits.length
      ? ["Pastas (use o nome no /novo):", ...hits.map((d) => `  ${d.name}`)].join(String.fromCharCode(10))
      : `Nenhuma pasta combina com "${q}".`);
    return;
  }

  if (/^\/novo/.test(text)) { await spawnAgent(text.replace(/^\/novo/, "")); return; }
  if (/^\/codex/.test(text)) { await spawnAgent(text.replace(/^\/codex/, ""), "codex"); return; }

  // Panes abertos na mao (inclusive Codex) nao se registram sozinhos ate
  // notificarem. /scan pega todos os que o wmux conhece.
  if (/^\/scan/.test(text)) {
    const out = await wmux(["agent", "list"]);
    let live = [];
    try { live = (JSON.parse(out).agents || []).filter((a) => a.status === "running"); } catch {}
    const added = live.map((a) => `[s:${registerSurface(a.surfaceId, a.label || a.cmd, a.agentId, a.cmd)}] ${a.label || a.cmd} (${a.cmd})`);
    await reply(added.length ? ["Registrados:", ...added].join(String.fromCharCode(10)) : "Nenhum pane ativo encontrado.");
    return;
  }

  if (/^\/matar/.test(text)) {
    const key = text.replace(/^\/matar/, "").trim().replace(/^\[?s:/, "").replace(/\]$/, "");
    const map = surfaces();
    const hit = map[key];
    if (!hit?.agentId) { await reply(`Nao achei agente [s:${key}]. /panes lista os ids.`); return; }
    await wmux(["agent", "kill", hit.agentId]);
    await reply(`Terminal ${hit.label} [s:${key}] encerrado.`);
    return;
  }

  if (text === "/ajuda" || text === "/help" || text === "/start") { await reply(HELP); return; }

  if (text === "/panes" || text === "/terminais") {
    const map = surfaces();
    const rows = Object.entries(map).filter(([k]) => k !== "__last")
      .sort((a, b) => b[1].at - a[1].at)
      .map(([k, v]) => `[s:${k}] ${v.label}${map.__last === k ? "  <- ultimo" : ""}`);
    await reply(rows.length ? `Terminais conhecidos:\n${rows.join("\n")}` : "Nenhum terminal registrado ainda.");
    return;
  }

  if (text.startsWith("/")) { await reply(HELP); return; }

  const hasReply = Boolean(update.message?.reply_to_message);
  log(`msg="${text.slice(0, 40)}" reply=${hasReply} requireTarget=${Boolean(cfg.requireTarget)}`);
  const target = resolve(update, text);
  if (target?.missing) { await reply(`Nao achei terminal "${target.missing}". Mande /panes para ver os ids.`); return; }
  if (!target) { await reply("Nao sei para qual terminal mandar. Responda a uma notificacao, use s:<id> ou @pasta, ou mande /panes."); return; }

  const body = target.body ?? text;
  // Marca: a proxima resposta deste pane volta para o celular mesmo se for curta.
  try { mkdirSync(STATE, { recursive: true }); writeFileSync(join(STATE, `phone-${target.key}.txt`), String(Date.now())); } catch {}
  await wmux(["send", "--surface", target.surface, body]);
  // a TUI precisa de um respiro entre o texto colado e o enter
  await new Promise((r) => setTimeout(r, 400));
  await wmux(["send-key", "enter", "--surface", target.surface]);
  log(`enviado para ${target.label} [${target.key}]: ${body.slice(0, 80)}`);
  await reply(`-> ${target.label} [s:${target.key}]`);
};


// Instancia unica: duas pontes fazendo getUpdates dao 409 no Telegram.
await new Promise((ok) => {
  const guard = createServer();
  guard.once("error", () => { console.error("bridge ja esta rodando"); process.exit(0); });
  guard.listen(49787, "127.0.0.1", ok);
});

let offset = existsSync(OFFSET) ? Number(readFileSync(OFFSET, "utf8")) || 0 : 0;
log(`bridge iniciou, offset=${offset}`);

while (true) {
  try {
    const r = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    if (!r.ok) { log(`getUpdates falhou: ${r.description}`); await new Promise((s) => setTimeout(s, 5000)); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      writeFileSync(OFFSET, String(offset));
      try { await handle(u); }
      catch (e) {
        log(`handle erro: ${e?.message} | ${String(e?.stack).split(String.fromCharCode(10))[1] || ""}`);
        try { await reply(`Falhei ao processar sua mensagem: ${e?.message}. Mande de novo.`); } catch {}
      }
    }
  } catch (e) {
    log(`loop erro: ${e?.message}`);
    await new Promise((s) => setTimeout(s, 5000));
  }
}
