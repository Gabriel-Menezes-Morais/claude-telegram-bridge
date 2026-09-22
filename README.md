# claude-telegram-bridge

Drive your **Claude Code**, **Codex** and **OpenCode** terminals from Telegram — see what every agent is doing, reply,
and spawn new agents, without sitting in front of the laptop.

Claude Code's own Remote Control ties push to the Claude account logged into the phone app.
If you work across several accounts, you end up switching accounts all day. This bridge is
account-agnostic: every terminal on the machine, under any account, reports to one Telegram
chat, and every reply is routed back to a specific terminal.

```
  terminal ──Stop/Notification hook──▶ Telegram  ("✅ myapp · 84s  <what the agent said>")
  terminal ◀──wmux send + Enter────── Telegram  ("myapp, run the tests"  — text or voice)
```

---

## What it does

- **Out:** when a Claude Code turn ends (longer than `minTurnSeconds`) or an agent stops for
  permission, the agent's last message lands in your Telegram.
- **Back:** you answer from the phone and the text is typed into that exact terminal and
  submitted — as if you had typed it.
- **Addressing:** every message carries `[s:<id>]`. Reply to it, or start your message with
  `s:<id>`, `@folder`, or simply the terminal's name when speaking.
- **Permission buttons:** a permission stop arrives with Yes / Yes always / No as inline buttons.
  One tap sends the keystroke to that pane and the buttons are removed, so the same question
  cannot be answered twice.
- **Voice:** send a voice note. It is transcribed (OpenAI Whisper), echoed back as
  `Ouvi: ...` so you can check it, then routed like any other message.
- **Fuzzy names:** speech-to-text mangles names ("claude" → "Cláudio"). Routing uses edit
  distance, so the terminal is still found.
- **Queue instead of interrupting:** an order sent while the pane is working (or waiting on
  a permission) is held, not typed into a running turn, and delivered the moment the agent
  goes idle. You are told it was queued.
- **Attachments both ways:** send a photo or a file and it lands in that terminal's folder,
  with the caption as the order and the path appended. An answer over 3800 characters comes
  back as a `.md` file instead of being truncated.
- **Spawning:** `/novo myapp | run the tests` opens a new Claude pane in that folder,
  answers the "trust this folder" prompt, waits for the TUI, and sends the task.

## Bot commands

| Command | Does |
| --- | --- |
| `/status` | panel: who is running, who is waiting on you, last line of each |
| `/parar s:<id>` | send Esc — interrupt without killing the terminal |
| `/diff s:<id> [file]` | what the agent actually changed, not what it says it changed |
| `/tela s:<id>` | last 25 lines of that pane |
| `/panes` | list live terminals with their ids |
| `/pastas [filter]` | list project folders you can spawn into |
| `/novo <folder> \| <task>` | new Claude terminal in that folder, already working |
| `/nome s:<id> <alias>` | give a terminal a name that is easy to say out loud |
| `/codex <folder> \| <task>` | the same, with Codex CLI |
| `/opencode <folder> \| <task>` | the same, with OpenCode |
| `/scan` | register panes you opened by hand |
| `/matar s:<id>` | kill that terminal |
| `/ajuda` | the list above |

Addressing a terminal, best first on a phone:

1. **Reply** to one of its notifications — the id travels in the quoted text.
2. Prefix: `s:eb2ac583 run the tests` or `@myapp run the tests`.
3. Speak the name first: *"myapp, run the tests"* — the name is stripped, the task is sent.

With `requireTarget: true` a message with no target is refused instead of guessed. That
matters once three terminals are running.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node 18+ (Node 20+ recommended; the bridge uses global `fetch` and `FormData`)
- [wmux](https://github.com/wmux) — the terminal multiplexer that owns the panes.
  **The outbound half works without it**; the return half (typing into a running TUI,
  spawning panes, pane ids) is built on `wmux send`, `send-key`, `read-screen`,
  `agent spawn` and `$WMUX_SURFACE_ID`.
- A Telegram bot from [@BotFather](https://t.me/BotFather) (free)
- Optional, for voice: an OpenAI API key (~US$0.006 per audio minute)

## Install

1. Copy the scripts:

   ```bash
   mkdir -p ~/.claude/hooks
   cp src/notify.mjs  ~/.claude/hooks/telegram-notify.mjs
   cp src/bridge.mjs  ~/.claude/hooks/bridge.mjs
   cp src/setup.mjs   ~/.claude/hooks/telegram-setup.mjs
   ```

2. Create a bot with `@BotFather`, send it any message, then:

   ```bash
   node ~/.claude/hooks/telegram-setup.mjs <BOT_TOKEN>
   ```

   It finds your `chat_id` on its own and writes `~/.claude/telegram.json`.

3. Register the hooks in `~/.claude/settings.json` (three events, **not** `async`, because
   the process exits before an async fetch completes):

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<HOME>/.claude/hooks/telegram-notify.mjs\"", "async": true }] }],
       "Stop":             [{ "hooks": [{ "type": "command", "command": "node \"<HOME>/.claude/hooks/telegram-notify.mjs\"", "timeout": 20 }] }],
       "Notification":     [{ "hooks": [{ "type": "command", "command": "node \"<HOME>/.claude/hooks/telegram-notify.mjs\"", "timeout": 20 }] }]
     }
   }
   ```

4. Start the daemon, and add it to startup (`Win+R` → `shell:startup`):

   ```bash
   node ~/.claude/hooks/bridge.mjs     # or: copy install/bridge.vbs into shell:startup
   ```

See `config.example.json` for every option.

## Configuration

| Key | Meaning |
| --- | --- |
| `botToken`, `chatId` | written by `setup.mjs`; only this chat is ever obeyed |
| `minTurnSeconds` | turns shorter than this do not notify (default 15). A turn that started from Telegram always answers back, however short |
| `requireTarget` | `true` refuses an unaddressed message instead of using the last terminal |
| `openaiKey`, `transcribeModel`, `transcribeLang` | voice transcription; omit to disable |
| `wmuxCli` | path to `wmux.js`; falls back to `$WMUX_CLI` and the default install |
| `projectRoots` | where `/pastas` and `/novo` look for folders; git repos rank first |

Changes are picked up on the next message — no restart.

## Security

- Only messages from the configured `chat_id` are executed. Anyone else who finds the bot
  is logged and ignored.
- A message from Telegram is **typed into a terminal running an AI agent**. Treat the bot
  token like a shell credential: whoever holds it can drive your machine.
- The token lives in `~/.claude/telegram.json`, which `.gitignore` excludes. If it ever
  leaks, revoke it in `@BotFather` and re-run `setup.mjs`.

## Debugging

Two logs, both under `~/.claude`:

- `telegram-hook.log` — did the hook fire, was the turn too short, what did Telegram answer
- `telegram-bridge.log` — every message received, how it was routed, every reply sent

Three failures worth knowing about, all found the hard way:

- **Node on Windows refuses to `spawn` a `.cmd`** — call `node wmux.js` directly, not the shim.
- **`send-key` takes the key first:** `send-key enter --surface <id>`.
- **An `async` Stop hook is killed** before its HTTP request finishes. Keep it synchronous.

## Codex CLI

The same bridge drives [Codex CLI](https://developers.openai.com/codex/cli) panes.

**Out** — Codex has no hook protocol like Claude Code's, but it has `notify`, a program it
calls with one JSON argument. Add to `~/.codex/config.toml`, above any `[table]`:

```toml
notify = ["node", "C:/Users/you/.claude/hooks/codex-notify.mjs"]
```

Forward slashes: in a double-quoted TOML string a backslash is an escape, so a Windows path
with `\` fails to parse. It fires on `agent-turn-complete`, carrying the last assistant
message, and registers the pane exactly like the Claude hook does.

**Back** — identical. `wmux send` types into any pane, whatever is running inside it, so
addressing by id, folder alias or spoken name works unchanged.

```
/codex myapp | fix the failing test
/scan                      # register panes you opened by hand
```

**One limitation:** `wmux read-screen` returns an empty buffer for Codex's TUI, so the
bridge cannot detect when Codex finished booting the way it does for Claude (where it also
answers the "trust this folder" prompt). `/codex` waits a fixed `bootSeconds` (default 15)
before sending the task. Raise it on a slow machine.

## OpenCode

Also supported. OpenCode has neither process hooks nor a `notify` program — it has a
plugin that receives the session event stream. Copy `src/opencode-plugin.js` to
`~/.config/opencode/plugin/telegram.js`; it is picked up on the next start.

It listens to `session.idle` (turn finished) and `permission.updated` (waiting on you), and
cross-references `message.updated` to keep the assistant's text apart from your own — a text
part does not carry a role, so without that cross-reference the bridge would send your own
prompt back to you.

```
/opencode myapp | refactor this module
```


## License

MIT — see [LICENSE](LICENSE).

---

🇧🇷 [Leia em português](README.pt-BR.md)
