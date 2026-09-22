// Ponte de volta: le as suas respostas no Telegram e digita no terminal wmux certo.
// Roda como daemon. Config e logs ficam em ~/.claude/.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
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
const fetchRetry = async (url, opts = {}, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const { timeoutMs = 8000, ...rest } = opts; return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { last = e; log(`rede falhou (${i + 1}/${tries}): ${e.cause?.code || e.message}`); }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw last;
};

const api = (m, body) => fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/${m}`, {
  // long-poll precisa de folga; o resto falha rapido
  timeoutMs: m === "getUpdates" ? 45000 : 8000,
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

const reply = async (text) => {
  if (text.length > 3800) {
    try { await sendDocument("resposta.md", text, text.slice(0, 200) + " ..."); return { ok: true }; } catch {}
  }
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
  "/status  - painel: quem roda, quem espera voce, ultima linha",
  "/panes  - lista os terminais e ids",
  "/parar s:<id>  - manda Esc, interrompe sem matar",
  "/diff s:<id> [arquivo]  - o que o agente mudou de verdade",
  "/tela s:<id>  - ultimas 25 linhas do pane",
  "/retomar s:<id>  - reabre a conversa de um terminal fechado",
  "",
  "Foto ou arquivo: mande respondendo a notificacao do terminal;",
  "a legenda vira a ordem e o caminho do arquivo vai junto.",
  "/pastas [filtro]  - lista os apelidos de pasta",
  "/novo <apelido> | <tarefa>  - abre um Claude novo ja com a tarefa",
  "/codex <apelido> | <tarefa>  - o mesmo, com o Codex",
  "/opencode <apelido> | <tarefa>  - o mesmo, com o OpenCode",
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


const QUEUE = `${HOME}/.claude/telegram-queue.json`;
const readQueue = () => { try { return existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, "utf8")) : []; } catch { return []; } };
const writeQueue = (q) => { try { writeFileSync(QUEUE, JSON.stringify(q, null, 2)); } catch {} };

// Estado do pane pelo wmux. "working" = digitar agora cai no meio da execucao.
const paneState = async (surface) => {
  try { return JSON.parse(await wmux(["agent-state", "--surface", surface]))?.state?.state || null; } catch { return null; }
};

const typeInto = async (surface, body) => {
  await wmux(["send", "--surface", surface, body]);
  // a TUI precisa de um respiro entre o texto colado e o enter
  await new Promise((r) => setTimeout(r, 400));
  await wmux(["send-key", "enter", "--surface", surface]);
};

const marcaCelular = (key) => {
  // A proxima resposta deste pane volta para o celular mesmo se for curta.
  try { mkdirSync(STATE, { recursive: true }); writeFileSync(join(STATE, `phone-${key}.txt`), String(Date.now())); } catch {}
};

// Entrega agora, ou enfileira se o agente estiver trabalhando ou bloqueado.
const deliver = async (target, body) => {
  const st = await paneState(target.surface);
  if (st === "working" || st === "blocked") {
    const q = readQueue();
    q.push({ key: target.key, surface: target.surface, label: target.label, body, at: Date.now() });
    writeQueue(q);
    log(`enfileirado para ${target.label} [${target.key}] (estado ${st})`);
    const quantos = q.filter((x) => x.key === target.key).length;
    await reply(`${target.label} esta ${st === "blocked" ? "esperando permissao" : "trabalhando"}. Guardei na fila (${quantos}) e mando quando terminar.`);
    return;
  }
  marcaCelular(target.key);
  await typeInto(target.surface, body);
  log(`enviado para ${target.label} [${target.key}]: ${body.slice(0, 80)}`);
  await reply(`-> ${target.label} [s:${target.key}]`);
};

// Despeja a fila assim que o pane sai de "working". Um item por pane por vez,
// senao tudo empilha na mesma tela e vira uma mensagem so.
const flushQueue = async () => {
  const q = readQueue();
  if (!q.length) return;
  const restante = [];
  const jaEnviado = new Set();
  for (const item of q) {
    if (jaEnviado.has(item.key)) { restante.push(item); continue; }
    const st = await paneState(item.surface);
    if (st === "working" || st === "blocked") { restante.push(item); continue; }
    marcaCelular(item.key);
    await typeInto(item.surface, item.body);
    jaEnviado.add(item.key);
    log(`fila -> ${item.label} [${item.key}]: ${item.body.slice(0, 60)}`);
    await reply(`Da fila -> ${item.label} [s:${item.key}]: ${item.body.slice(0, 60)}`);
  }
  writeQueue(restante);
};


// Resposta longa vira arquivo em vez de ser cortada em 3800 caracteres.
const sendDocument = async (nome, conteudo, legenda) => {
  const form = new FormData();
  form.append("chat_id", String(cfg.chatId));
  form.append("document", new Blob([conteudo], { type: "text/markdown" }), nome);
  if (legenda) form.append("caption", legenda.slice(0, 900));
  const r = await fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/sendDocument`, { method: "POST", body: form });
  log(`documento ${nome} http ${r.status}`);
};

const git = (cwd, args) => new Promise((res) => {
  execFile("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 8e6 }, (err, out, errOut) => {
    res(String(out || errOut || (err ? err.message : "")));
  });
});

// Baixa foto/documento do Telegram para a pasta do terminal.
const baixarAnexo = async (fileId, nomeSugerido, destinoDir) => {
  const info = await (await fetchRetry(`https://api.telegram.org/bot${cfg.botToken}/getFile?file_id=${fileId}`)).json();
  if (!info.ok) throw new Error(info.description || "getFile falhou");
  const r = await fetchRetry(`https://api.telegram.org/file/bot${cfg.botToken}/${info.result.file_path}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = `${destinoDir}/telegram-anexos`;
  await mkdir(dir, { recursive: true });
  const ext = (info.result.file_path.split(".").pop() || "bin").toLowerCase();
  const nome = nomeSugerido || `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const destino = `${dir}/${nome}`;
  writeFileSync(destino, buf);
  log(`anexo salvo: ${destino} (${buf.length} bytes)`);
  return destino;
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
  return { key: best.k.key, surface: best.k.surface, cwd: best.k.cwd, label: best.k.alias || best.k.label, body };
};

// Tres formas de dizer para qual terminal vai, nesta ordem:
//   1. prefixo explicito no texto:  "s:ab12cd34 roda os testes"  ou  "@hunter roda os testes"
//   2. responder (reply) a notificacao daquele terminal
//   3. nenhuma das duas -> o ultimo terminal que notificou
const resolve = (update, text) => {
  const map = surfaces();
  const pick = (key) => (key && map[key] ? { key, body: null, ...map[key] } : null);  // ...map traz surface, label, cwd, agent

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


// Clique em botao de permissao: "k:<id>:<tecla>" vira tecla no pane.
const handleCallback = async (q) => {
  if (String(q.message?.chat?.id ?? q.from?.id) !== String(cfg.chatId)) { log(`callback ignorado de ${q.from?.id}`); return; }
  const data = String(q.data || "");
  const m = data.match(/^k:([0-9a-f]{4,8}):(.+)$/);
  const ack = (t) => api("answerCallbackQuery", { callback_query_id: q.id, text: t.slice(0, 200) });
  if (!m) { await ack("Botao nao reconhecido"); return; }

  const map = surfaces();
  const key = Object.keys(map).find((k) => k !== "__last" && k.startsWith(m[1]));
  const hit = key && map[key];
  if (!hit) { await ack("Terminal nao existe mais"); return; }

  await wmux(["send-key", m[2], "--surface", hit.surface]);
  log(`botao ${m[2]} -> ${hit.label} [${key}]`);
  await ack(`Enviado: ${m[2]}`);
  // Tira os botoes para nao clicar duas vezes na mesma pergunta.
  await api("editMessageReplyMarkup", { chat_id: cfg.chatId, message_id: q.message?.message_id, reply_markup: { inline_keyboard: [] } });
  await reply(`${m[2] === "esc" ? "Recusado" : "Aprovado"} em ${hit.label} [s:${key}]`);
};

const handle = async (update) => {
  reloadCfg();
  if (update.callback_query) { await handleCallback(update.callback_query); return; }
  log(`recebido: ${JSON.stringify(update.message?.text || "(sem texto)").slice(0, 120)}`);
  const msg = update.message;
  if (!msg) return;
  if (String(msg.chat?.id) !== String(cfg.chatId)) { log(`ignorado chat ${msg.chat?.id}`); return; }

  // Foto ou arquivo: salva na pasta do terminal e entrega o caminho ao agente.
  const anexo = (msg.photo && msg.photo[msg.photo.length - 1]) || msg.document;
  if (anexo) {
    const legenda = (msg.caption || "").trim();
    const alvo2 = resolve(update, legenda || "");
    if (!alvo2 || alvo2.missing) { await reply("Mande o arquivo respondendo a notificacao do terminal, ou com legenda s:<id> ..."); return; }
    if (!alvo2.cwd) { await reply(`Nao sei a pasta de ${alvo2.label} ainda. Ele precisa notificar uma vez primeiro.`); return; }
    let caminho;
    try { caminho = await baixarAnexo(anexo.file_id, msg.document?.file_name, alvo2.cwd); }
    catch (e) { await reply(`Nao consegui salvar o arquivo: ${e.message}`); return; }
    const ordem = (alvo2.body || legenda)
      ? `${alvo2.body || legenda}${String.fromCharCode(10)}${String.fromCharCode(10)}Arquivo: ${caminho}`
      : `Recebi um arquivo em: ${caminho}`;
    await reply(`Salvo em ${caminho}`);
    await deliver(alvo2, ordem);
    return;
  }

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
  if (/^\/opencode/.test(text)) { await spawnAgent(text.replace(/^\/opencode/, ""), "opencode"); return; }

  // Panes abertos na mao (inclusive Codex) nao se registram sozinhos ate
  // notificarem. /scan pega todos os que o wmux conhece.
  if (/^\/retomar/.test(text)) {
    const key0 = text.replace(/^\/retomar/, "").trim().replace(/^\[?s:/, "").replace(/\]$/, "");
    const map = surfaces();
    const key = key0 ? Object.keys(map).find((k) => k !== "__last" && k.startsWith(key0.toLowerCase())) : map.__last;
    const hit = key && map[key];
    if (!hit) { await reply("Use: /retomar s:<id>. /status lista os ids."); return; }
    if (!hit.cwd) { await reply(`Nao sei a pasta de ${hit.label}; nao da para retomar.`); return; }

    const agente = hit.agent || "claude";
    // So o Codex nao expoe id de sessao para o wmux; nele o melhor disponivel
    // e a ultima sessao daquela pasta.
    const cmd = agente === "codex" ? "codex resume --last"
      : agente === "opencode" ? (hit.sessionId ? `opencode --session ${hit.sessionId}` : "opencode --continue")
      : (hit.sessionId ? `claude --resume ${hit.sessionId}` : "claude --continue");

    const out = await wmux(["agent", "spawn", "--cmd", cmd, "--cwd", hit.cwd, "--label", hit.label]);
    let ids;
    try { ids = JSON.parse(out); } catch { await reply(`Nao consegui abrir o terminal em ${hit.cwd}.`); return; }

    const novo = registerSurface(ids.surfaceId, hit.label, ids.agentId, agente);
    const m2 = surfaces();
    m2[novo] = { ...m2[novo], cwd: hit.cwd, alias: hit.alias, sessionId: hit.sessionId };
    try { writeFileSync(SURFACES, JSON.stringify(m2, null, 2)); } catch {}
    log(`retomado ${hit.label}: ${cmd}`);
    await reply(`Retomando ${hit.label} com "${cmd}" [s:${novo}].${hit.sessionId ? "" : " Sem id de sessao guardado: abri a ultima daquela pasta."}`);
    return;
  }

  if (/^\/diff/.test(text)) {
    const arg = text.replace(/^\/diff/, "").trim();
    const mm = arg.match(/^\[?s:?([0-9a-f]{4,8})\]?\s*(.*)$/i);
    const map = surfaces();
    const key = mm ? Object.keys(map).find((k) => k !== "__last" && k.startsWith(mm[1].toLowerCase())) : map.__last;
    const hit = key && map[key];
    if (!hit) { await reply("Use: /diff s:<id> [arquivo]. /status lista os ids."); return; }
    if (!hit.cwd) { await reply(`Nao sei a pasta de ${hit.label} ainda. Ele precisa notificar uma vez primeiro.`); return; }

    const arquivo = (mm && mm[2] || "").trim();
    if (arquivo) {
      const d = await git(hit.cwd, ["diff", "--", arquivo]);
      await reply(d.trim() ? `${hit.label} · ${arquivo}

${d}` : `Sem mudancas em ${arquivo}.`);
      return;
    }
    const [stat, status] = [await git(hit.cwd, ["diff", "--stat"]), await git(hit.cwd, ["status", "--short"])];
    const corpo = [stat.trim() && `Modificado:
${stat.trim()}`, status.trim() && `Arvore:
${status.trim()}`].filter(Boolean).join(String.fromCharCode(10) + String.fromCharCode(10));
    await reply(corpo ? `${hit.label} [s:${key}]

${corpo}` : `Nada mudou em ${hit.label}.`);
    return;
  }

  if (/^\/tela/.test(text)) {
    const key0 = text.replace(/^\/tela/, "").trim().replace(/^\[?s:/, "").replace(/\]$/, "");
    const map = surfaces();
    const key = key0 ? Object.keys(map).find((k) => k !== "__last" && k.startsWith(key0.toLowerCase())) : map.__last;
    const hit = key && map[key];
    if (!hit) { await reply("Use: /tela s:<id>. /status lista os ids."); return; }
    let tela = "";
    try { tela = JSON.parse(await wmux(["read-screen", "--surface", hit.surface, "--lines", "25"])).text || ""; } catch {}
    if (!tela.trim()) { await reply(`Tela vazia em ${hit.label}. O Codex nao devolve tela para o wmux.`); return; }
    await reply(`${hit.label} [s:${key}]

${tela.trim()}`);
    return;
  }

  if (/^\/status/.test(text)) {
    const map = surfaces();
    const known = Object.entries(map).filter(([k]) => k !== "__last");
    if (!known.length) { await reply("Nenhum terminal registrado. Mande /scan."); return; }

    let states = [];
    try { states = JSON.parse(await wmux(["agent-state"])).states || []; } catch {}
    let agents = [];
    try { agents = JSON.parse(await wmux(["agent", "list"])).agents || []; } catch {}

    const ha = (ms) => {
      const s2 = Math.round((Date.now() - ms) / 1000);
      return s2 < 90 ? `${s2}s` : s2 < 5400 ? `${Math.round(s2 / 60)}min` : `${Math.round(s2 / 3600)}h`;
    };
    const ICON = { working: "🔵", blocked: "🔴", done: "🟢", idle: "⚪" };

    const linhas = known.sort((a, b) => b[1].at - a[1].at).map(([k, v]) => {
      const st = states.find((x) => x.surfaceId === v.surface);
      const ag = agents.find((x) => x.surfaceId === v.surface);
      const morto = ag && ag.status !== "running";
      const estado = morto ? "encerrado" : st?.state || "sem sinal";
      const icone = morto ? "⚫" : ICON[estado] || "⚪";
      const nome = v.alias ? `${v.alias} (${v.label})` : v.label;
      const cabeca = `${icone} ${nome} · ${v.agent || "claude"} · ${estado} · ha ${ha(v.at)} [s:${k}]`;
      const razao = st?.blockedReason ? `
   aguardando: ${String(st.blockedReason).slice(0, 90)}` : "";
      const ultima = v.lastMsg ? `
   ${String(v.lastMsg).replace(/\s+/g, " ").slice(0, 90)}` : "";
      return cabeca + razao + ultima;
    });
    await reply(["Terminais:", ...linhas].join(String.fromCharCode(10)));
    return;
  }

  if (/^\/parar/.test(text)) {
    const key0 = text.replace(/^\/parar/, "").trim().replace(/^\[?s:/, "").replace(/\]$/, "");
    const map = surfaces();
    const key = Object.keys(map).find((k) => k !== "__last" && k.startsWith(key0.toLowerCase()));
    if (!key) { await reply(`Nao achei [s:${key0}]. /status lista os ids.`); return; }
    await wmux(["send-key", "esc", "--surface", map[key].surface]);
    await reply(`Esc enviado para ${map[key].label} [s:${key}]. O terminal continua vivo.`);
    return;
  }

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

  await deliver(target, target.body ?? text);
};


// Instancia unica: duas pontes fazendo getUpdates dao 409 no Telegram.
await new Promise((ok) => {
  const guard = createServer();
  guard.once("error", () => { console.error("bridge ja esta rodando"); process.exit(0); });
  guard.listen(49787, "127.0.0.1", ok);
});

try { mkdirSync(STATE, { recursive: true }); } catch {}

// O wmux conhece o sessionId de cada pane vivo. Guardar enquanto ele existe e
// o que torna possivel retomar depois que o terminal fechou.
const varrerSessoes = async () => {
  let states = [];
  try { states = JSON.parse(await wmux(["agent-state"])).states || []; } catch { return; }
  const map = surfaces();
  let mudou = false;
  for (const st of states) {
    if (!st.sessionId) continue;
    const key = Object.keys(map).find((k) => k !== "__last" && map[k].surface === st.surfaceId);
    if (key && map[key].sessionId !== st.sessionId) { map[key].sessionId = st.sessionId; mudou = true; }
  }
  if (mudou) { try { writeFileSync(SURFACES, JSON.stringify(map, null, 2)); } catch {} }
};

const HEARTBEAT = `${HOME}/.claude/telegram-bridge.heartbeat`;
const bater = () => { try { writeFileSync(HEARTBEAT, String(Date.now())); } catch {} };
bater();
setInterval(bater, 30000);
setInterval(() => { varrerSessoes().catch(() => {}); }, 30000);
varrerSessoes().catch(() => {});

setInterval(() => { flushQueue().catch((e) => log(`flush erro: ${e?.message}`)); }, 3000);

let offset = existsSync(OFFSET) ? Number(readFileSync(OFFSET, "utf8")) || 0 : 0;
log(`bridge iniciou, offset=${offset}`);

while (true) {
  try {
    const r = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
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
