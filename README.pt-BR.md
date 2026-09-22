# claude-telegram-bridge

Controle seus terminais do **Claude Code**, **Codex** e **OpenCode** pelo Telegram — veja o que cada agente está
fazendo, responda, e abra agentes novos, sem ficar na frente do notebook.

O Remote Control nativo do Claude Code amarra o push à conta logada no app do celular.
Quem usa várias contas acaba trocando de conta o dia inteiro. Esta ponte é agnóstica de
conta: todo terminal da máquina, de qualquer conta, reporta para um único chat do Telegram,
e cada resposta volta para um terminal específico.

```
  terminal ──hook Stop/Notification──▶ Telegram  ("✅ myapp · 84s  <o que o agente disse>")
  terminal ◀──wmux send + Enter────── Telegram  ("myapp, roda os testes"  — texto ou áudio)
```

## O que faz

- **Ida:** quando um turno termina (acima de `minTurnSeconds`) ou o agente para pedindo
  permissão, a última mensagem dele chega no seu Telegram.
- **Volta:** você responde do celular e o texto é digitado naquele terminal e enviado.
- **Endereçamento:** toda mensagem carrega `[s:<id>]`. Responda a ela, ou comece com
  `s:<id>`, `@pasta`, ou simplesmente o nome do terminal quando falar.
- **Botões de permissão:** a parada por permissão chega com Sim / Sim sempre / Não como
  botões. Um toque manda a tecla para aquele pane e os botões somem, então a mesma pergunta
  não é respondida duas vezes.
- **Áudio:** mande um áudio. Ele é transcrito (Whisper), devolvido como `Ouvi: ...` para
  você conferir, e roteado como qualquer mensagem.
- **Nome falado tolerante a erro:** a transcrição troca "claude" por "Cláudio". O
  roteamento usa distância de edição e acha o terminal mesmo assim.
- **Avisa quando está morta:** o daemon segura uma trava na porta 49787 e toca um arquivo de
  batimento. Toda notificação sonda essa porta, e mensagem enviada com o daemon caído chega
  com um aviso — senão a ida continua funcionando e suas respostas somem sem sinal nenhum.
- **Fila em vez de atropelo:** ordem mandada enquanto o pane está trabalhando (ou esperando
  permissão) fica guardada, não é digitada no meio do turno, e entra assim que o agente fica
  ocioso. O bot te avisa que enfileirou.
- **Anexos nos dois sentidos:** mande foto ou arquivo e ele cai na pasta daquele terminal,
  com a legenda virando a ordem e o caminho junto. Resposta acima de 3800 caracteres volta
  como arquivo `.md` em vez de ser cortada.
- **Abrir agentes:** `/novo myapp | roda os testes` abre um pane Claude naquela pasta,
  responde o "trust this folder", espera a TUI subir e manda a tarefa.

## Comandos do bot

| Comando | Faz |
| --- | --- |
| `/status` | painel: quem roda, quem espera você, última linha de cada um |
| `/parar s:<id>` | manda Esc — interrompe sem matar o terminal |
| `/diff s:<id> [arquivo]` | o que o agente mudou de verdade, não o que ele diz que mudou |
| `/tela s:<id>` | últimas 25 linhas do pane |
| `/retomar s:<id>` | reabre um terminal fechado na mesma conversa |
| `/panes` | lista os terminais vivos com os ids |
| `/pastas [filtro]` | lista as pastas de projeto disponíveis |
| `/novo <pasta> \| <tarefa>` | terminal Claude novo naquela pasta, já trabalhando |
| `/nome s:<id> <apelido>` | dá ao terminal um nome fácil de falar |
| `/codex <pasta> \| <tarefa>` | o mesmo, com o Codex CLI |
| `/opencode <pasta> \| <tarefa>` | o mesmo, com o OpenCode |
| `/scan` | registra panes abertos na mão |
| `/matar s:<id>` | encerra aquele terminal |
| `/ajuda` | a lista acima |

Para endereçar um terminal, do melhor ao pior no celular:

1. **Responda** (reply) uma notificação dele — o id viaja no texto citado.
2. Prefixo: `s:eb2ac583 roda os testes` ou `@myapp roda os testes`.
3. Fale o nome primeiro: *"myapp, roda os testes"* — o nome é cortado, a tarefa é enviada.

Com `requireTarget: true`, mensagem sem destino é recusada em vez de chutada. Isso importa
quando há três terminais rodando.

## Requisitos

- [Claude Code](https://claude.com/claude-code)
- Node 18+ (recomendado 20+; a ponte usa `fetch` e `FormData` globais)
- [wmux](https://github.com/wmux) — o multiplexador que é dono dos panes.
  **A ida funciona sem ele**; a volta (digitar dentro de uma TUI rodando, abrir panes, ids
  de pane) é construída sobre `wmux send`, `send-key`, `read-screen`, `agent spawn` e
  `$WMUX_SURFACE_ID`.
- Um bot do [@BotFather](https://t.me/BotFather) (grátis)
- Opcional, para áudio: uma chave da OpenAI (~US$0,006 por minuto de áudio)

## Instalação

1. Copie os scripts:

   ```bash
   mkdir -p ~/.claude/hooks
   cp src/notify.mjs  ~/.claude/hooks/telegram-notify.mjs
   cp src/bridge.mjs  ~/.claude/hooks/bridge.mjs
   cp src/setup.mjs   ~/.claude/hooks/telegram-setup.mjs
   ```

2. Crie o bot no `@BotFather`, mande qualquer mensagem para ele, e rode:

   ```bash
   node ~/.claude/hooks/telegram-setup.mjs <TOKEN_DO_BOT>
   ```

   Ele descobre o `chat_id` sozinho e escreve `~/.claude/telegram.json`.

3. Registre os hooks em `~/.claude/settings.json` — três eventos, e **não** use `async` em
   `Stop`/`Notification`: o processo encerra antes de a requisição terminar.

4. Suba o daemon e ponha no boot (`Win+R` → `shell:startup`, copiando `install/bridge.vbs`):

   ```bash
   node ~/.claude/hooks/bridge.mjs
   ```

Veja `config.example.json` para todas as opções.

## Segurança

- Só mensagens do `chat_id` configurado são executadas; o resto é registrado e ignorado.
- Uma mensagem do Telegram é **digitada num terminal com um agente de IA**. Trate o token
  do bot como credencial de shell: quem o tiver dirige sua máquina.
- O token fica em `~/.claude/telegram.json`, excluído pelo `.gitignore`. Se vazar, revogue
  no `@BotFather` e rode o `setup.mjs` de novo.

## Diagnóstico

Dois logs, em `~/.claude`: `telegram-hook.log` (ida) e `telegram-bridge.log` (volta).

Três armadilhas que custaram tempo:

- **Node no Windows recusa `spawn` de `.cmd`** — chame `node wmux.js` direto, não o shim.
- **`send-key` recebe a tecla primeiro:** `send-key enter --surface <id>`.
- **Hook `Stop` com `async` é morto** antes de a requisição HTTP terminar.

### Mantendo o daemon de pé

A trava faz a segunda instância sair na hora, então um supervisor burro basta. No Windows,
uma tarefa agendada a cada cinco minutos cobre boot e queda:

```
schtasks /Create /TN "ClaudeTelegramBridge" /SC MINUTE /MO 5 /F ^
  /TR "wscript.exe \"%USERPROFILE%\.claude\hooks	elegram-bridge.vbs\""
```

O `/retomar` precisa de um id de sessão, que a ponte colhe do `wmux agent-state` a cada 30
segundos enquanto o pane existe. Claude Code e OpenCode expõem um e são retomados
exatamente; o Codex não, então ele cai na última sessão daquela pasta.

## Codex CLI

A mesma ponte serve panes do [Codex CLI](https://developers.openai.com/codex/cli).

**Ida** — o Codex não tem protocolo de hooks como o Claude Code, mas tem `notify`, um
programa chamado com um argumento JSON. Em `~/.codex/config.toml`, acima de qualquer
`[tabela]`:

```toml
notify = ["node", "C:/Users/voce/.claude/hooks/codex-notify.mjs"]
```

Barras normais: em string TOML com aspas duplas a barra invertida é escape, e um caminho
Windows com `\` não faz o parse. Dispara em `agent-turn-complete`, com a última mensagem
do agente, e registra o pane igual ao hook do Claude.

**Volta** — idêntica. O `wmux send` digita em qualquer pane, seja lá o que estiver rodando
dentro, então id, apelido de pasta e nome falado funcionam sem mudança.

```
/codex myapp | conserta o teste que quebrou
/scan                      # registra panes abertos na mão
```

**Uma limitação:** o `wmux read-screen` volta vazio na TUI do Codex, então a ponte não
detecta quando o Codex terminou de subir, como faz com o Claude (onde ainda responde o
"trust this folder"). O `/codex` espera um `bootSeconds` fixo (padrão 15) antes de mandar a
tarefa. Aumente em máquina lenta.

## OpenCode

Também suportado. O OpenCode não tem hook de processo nem programa `notify` — tem um
plugin que recebe o fluxo de eventos da sessão. Copie `src/opencode-plugin.js` para
`~/.config/opencode/plugin/telegram.js`; ele é carregado no próximo start.

Ele escuta `session.idle` (turno terminou) e `permission.updated` (esperando você), e cruza
com `message.updated` para separar o texto do agente do seu — uma parte de texto não carrega
o papel, e sem esse cruzamento a ponte devolveria o seu próprio prompt.

```
/opencode myapp | refatora esse módulo
```


## Licença

MIT — veja [LICENSE](LICENSE).
