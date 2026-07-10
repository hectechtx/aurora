# AURORA

A local, Ollama-brained autonomous vessel: perceive (chat + history) → prompt a local Ollama model → parse tool calls → execute or wait for your approval → feed results back → repeat. Capabilities can be extended by downloading skills straight from a GitHub repo — nothing a skill contributes ever runs until you've reviewed and approved it.

Architecture pattern borrowed from the `evo-jarvis-src` project (Express + Vite + React + Drizzle/SQLite, audit log, human-approval gate) but scoped to a single-user, local-only app — Ollama only ever runs on your own machine, so there's no hosted/multi-user mode here.

## Run it

1. Install [Ollama](https://ollama.com) and start it: `ollama serve`
2. `npm install`
3. `npm run dev` → opens on `http://localhost:4700` (walks to the next free port if taken)
4. First run asks you to set a PIN — it's the only thing gating access to the vessel's tools on this device, and there's no recovery flow if you forget it
5. Go to **Settings**, pull a tool-calling-capable model (`llama3.1`, `qwen2.5`, `mistral-nemo`, etc.) and select it as active

Bound to `127.0.0.1` only, by design — nothing else on your network can reach it, PIN or not.

## How it works

- **Tasks** — every conversation with the vessel is its own task/thread with its own history, so you can run several unrelated things side by side without them sharing context. Tool calls made (or wanted) show up inline under each reply. Persistent memory (see below) is the one thing shared *across* tasks.
- **Library** — generated images land here (see Image generation below).
- **Memory** — the notes AURORA has saved about you via its `remember`/`recall` tools, shared across every task. Search or delete them directly.
- **Terminal** — compose a shell/Node/Python command by hand (with quick presets for common dev tasks) and submit it. It goes through the exact same approvals queue as a command the vessel proposes mid-conversation — nothing runs until you say yes.
- **Agents** — persistent named workers, separate from Tasks. Each has its own persona, job description, perpetual private memory (see Agents section below), and a suggestion queue it works through on its own schedule (or only when you hit "Run now"). Built on the exact same engine as Tasks — the only difference is where things get persisted.
- **Outbox** — finished content agents produce via `save_deliverable` (title, description, tags, body, optional thumbnail) lands here for you to copy and post yourself. Nothing is ever posted automatically.
- **Skills** — install a capability by pointing at a GitHub repo (`owner/repo`, a full URL, optionally a branch/tag and subpath). The repo must have a `skill.json` manifest at its root (or the given subpath) declaring the tools it exposes — see `server/skills/manifest.ts` for the schema. Every install lands in **Approvals** first, showing the full manifest and file listing before any downloaded code runs.
- **Approvals** — anything high-risk (raw shell/Node/Python execution, terminal requests, skill installs, any skill tool declared `risk: "high"`) always waits here, whether it came from a Task or an Agent. Everything else auto-runs when Autonomy is set to "Supervised" (the default); set it to "Manual" to require approval on every tool call. Each entry shows a plain-language description of what it actually does, not just raw JSON args.
- **Audit Log** — a durable record of everything the vessel did or was asked to do.
- **Settings** — Ollama host/model, image-gen host, autonomy level, voice, the system prompt/persona (defaults to a sassy, playful, direct young-woman persona — edit freely), and Security (change PIN, log out).

## Security

- **PIN** — set on first run, gates every `/api/*` route. Sessions are Bearer tokens held in server memory (30-day TTL) — restarting the server signs everyone out.
- **Advanced tools** — off by default in Settings. While off, the Terminal page and GitHub skill installation are disabled outright (not just approval-gated) — raw shell/Node/Python execution and running code downloaded from a repo are both real risks, so they require an explicit, informed opt-in beyond the normal approvals queue.

## Agents

Unlike a Task (a conversation you drive turn by turn), an Agent is a standing worker: give it a name, a persona/voice, and a job description, and it ticks through its own suggestion queue on its own — either on a schedule (every 15 min, hourly, daily, etc.) or only when you click "Run now." Each agent has its own perpetual memory, completely separate from a Task's shared memory and from every other agent's — ask one agent something and a different agent won't know it, exactly like two different employees.

Every tool an agent uses goes through the exact same risk gating as a Task: low-risk tools (`remember`, `recall`, `save_deliverable`, `web_search`, `web_fetch`) auto-run under Supervised autonomy; anything high-risk (`run_shell`, `run_node`, `run_python`) always waits in Approvals first, regardless of how the agent is scheduled. A paused agent (or one with an empty queue) simply does nothing on its scheduled ticks — the background scheduler checks every agent once a minute and only acts on the ones that are due with something to do.

The included example is a YouTube-persona agent: give it a comedic/chill persona and a job description like "come up with video ideas, write scripts/titles/descriptions/tags, and generate a thumbnail concept, then save each as a deliverable." It produces real scripts and metadata via the LLM and (if you've set up Image generation) a thumbnail — video generation itself isn't possible with free/local tools yet, and actual publishing to any platform requires that platform's own API credentials, which only you can provide, so agents hand off finished work to the Outbox instead of posting it themselves.

## Web access

Both Tasks and Agents can search and read the live web via two built-in tools, no API key required:

- `web_search` — queries DuckDuckGo's lite endpoint and returns titles/URLs/snippets.
- `web_fetch` — fetches a URL and returns its readable text (HTML stripped, truncated to ~8,000 characters). Guards against SSRF: every hop, including redirects, is checked against loopback/private/link-local IP ranges before the request is made, so a tool call can't be used to probe services on your own machine or LAN.

Both are classified low-risk (auto-run under Supervised autonomy, same as `remember`/`recall`) since they're read-only outbound requests with no side effects on your system. This is what makes an Agent's scheduled/unattended runs actually useful — without it, an agent can only work from what's already in the model's training data or your own memory notes.

## Voice

Spoken replies use the browser's built-in text-to-speech (`SpeechSynthesis`) — free, local, no API keys, no server component. Toggle it on in Settings or from the speaker icon in a task's header; voice quality and the list of available voices depend entirely on what your OS/browser ships (Windows picks a female voice like "Zira" by default when available). Each assistant reply can also be replayed individually via the speaker icon that appears on hover.

## Image generation

There's no paid API integration on purpose. If you have a local [Automatic1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui) or ComfyUI (with its Automatic1111-compatible API) instance running, put its URL in Settings → Image generation, and the vessel's `generate_image` tool will call it and save results to the Library. Without one configured, the tool just reports it's unavailable — no silent fallback to a hosted service. Video generation isn't wired up (no comparable lightweight local API exists yet).

## Writing a skill

A skill is a git repo with:

- `skill.json` — name, version, description, `entrypoint` (a JS file in the repo), `risk`, and a `tools[]` array (each with `name`, `description`, a JSON-Schema `parameters` object, and its own `risk`).
- The entrypoint reads one JSON line from stdin — `{"tool": "<name>", "args": {...}}` — and must print a single JSON value to stdout as the result.

Skills run as a plain Node child process in their own directory with the owner's OS privileges — there's no network sandbox, only a filesystem one. The real safety boundary is your review of the manifest and file listing at install time, not the runtime.

## Building the desktop app

AURORA also packages as a real Electron desktop app — same server, same UI, just hosted in a native window instead of a browser tab, with a tray icon so closing the window doesn't kill running agents. A packaged build stores its data in Electron's per-user folder (`%APPDATA%\aurora\data` on Windows), completely separate from the `./data` folder `npm run dev` uses.

- `npm run electron:dev` — builds and launches the Electron shell locally, for a quick check.
- `npm run dist` — builds a real installer into `release/` (`AURORA Setup <version>.exe` on Windows, via `electron-builder` + NSIS). Unsigned — Windows SmartScreen will warn on first run ("More info" → "Run anyway"). Real code signing needs a paid cert tied to a legal identity; not set up here.

**Native module ABI gotcha:** `better-sqlite3` has to be compiled against whichever runtime is going to load it — Node for the CLI (`npm run dev` / `npm start`), Electron for the packaged app — and the two are *not* binary-compatible. Building/testing the Electron app leaves the module compiled for Electron, which breaks `npm run dev` until it's rebuilt back:

```
npm run rebuild:electron   # before npm run electron:dev — npm run dist does this itself
npm run rebuild:node       # after, to go back to using npm run dev / npm start
```

If `npm run dev` suddenly throws a `NODE_MODULE_VERSION` mismatch error, this is why — run `npm run rebuild:node`.
