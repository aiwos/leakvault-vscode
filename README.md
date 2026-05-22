# LeakVault — AI Credential Guard

**Stop your passwords and API keys from reaching AI chat servers.**

LeakVault sits between you and the AI. Before any message is sent — whether through GitHub Copilot Chat, Claude Code, or the OpenAI Codex VS Code panel — it scans the text, pulls out any secrets it finds, replaces them with safe placeholder handles, and stores the originals in an encrypted local vault. The AI never sees the real values.

---

## How it works

1. You write a message that accidentally contains a token, password, or connection string.
2. LeakVault detects it using pattern matching and entropy analysis.
3. The secret is replaced with a handle like `GPG[3f7a9c12b401]`.
4. The redacted message is forwarded to the AI model.
5. The real value is encrypted with AES-256-GCM and saved to `~/.leakvault/`.

The AI only ever sees the handle — never the original credential.

---

## Detected credential types

| Type | Example pattern |
|------|----------------|
| AWS Access Key ID | `AKIA...` / `ASIA...` (20 chars) |
| AWS Secret Access Key | `aws_secret_access_key = <40-char value>` |
| GitHub Personal Access Token | `ghp_...`, `github_pat_...`, `gho_...`, `ghs_...`, `ghr_...` |
| OpenAI API key | `sk-...` / `sk-proj-...` |
| Anthropic API key | `sk-ant-api...` / `sk-ant-admin01-...` |
| Stripe secret / restricted key | `sk_live_...`, `sk_test_...`, `rk_live_...`, `rk_test_...` |
| JSON Web Token (JWT) | `eyJ....<payload>.<signature>` |
| npm access token | `npm_...` (36 chars) |
| Slack bot / user token | `xoxb-...`, `xoxa-...`, `xoxp-...`, `xoxr-...`, `xoxs-...` |
| Slack incoming webhook URL | `https://hooks.slack.com/services/...` |
| Google API key | `AIza...` (39 chars) |
| Database connection URL | `postgres://user:`**password**`@host` — only the password segment is redacted |
| Generic `key = value` assignments | Fields named `password`, `secret`, `api_key`, `auth_token`, `access_token`, `private_key` with values ≥ 12 characters |
| Natural language passwords | `my password is Tr0ub4dor3`, `password is ...` |
| High-entropy standalone tokens | Any 16–64 character token with Shannon entropy ≥ 3.5 bits/char and 3+ character classes (letters, digits, symbols) — catches unknown or custom tokens |

---

## Features

### @leakvault chat participant

Type `@leakvault` in GitHub Copilot Chat to route your message through LeakVault before it reaches the model.

```
@leakvault Here is my config: DATABASE_URL=postgres://admin:s3cr3t@db.prod.example.com/app
```

LeakVault redacts the password, warns you, and forwards the safe version.

**Slash commands:**
- `@leakvault /scan` — explicitly scan and redact before answering
- `@leakvault /vault` — list all credential handles stored in the vault

#### Known gap: Copilot Chat without `@leakvault`

If you type a normal prompt into GitHub Copilot Chat **without** prefixing it with `@leakvault`, LeakVault cannot see or scan it. The VS Code public extension API exposes no pre-submit hook for arbitrary chat input — third-party participants are only invoked when the user explicitly `@`-mentions them, and the chat participant `disambiguation` system gives built-in participants (Copilot) precedence. There is no public `onWillSendChatRequest` event.

For Copilot Chat:

- **Always type `@leakvault` first** when your message might contain a secret.
- Or use **LeakVault: Scan & Redact Clipboard** before pasting into Copilot Chat.

For Claude Code and the OpenAI Codex VS Code panel this gap does not exist — both honor file-based hooks that LeakVault registers automatically (see the Claude Code and Codex sections below).

### Clipboard and selection scanning

Use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) to scan text without sending it anywhere:

- **LeakVault: Scan & Redact Clipboard** — reads your clipboard, redacts it, and copies the clean version back
- **LeakVault: Scan & Redact Selection** — redacts the currently selected text in the editor

### Status bar indicator

A small `🔒` icon in the status bar shows protection is active. It flashes when credentials are intercepted.

### Claude Code integration

LeakVault automatically installs hooks into `~/.claude/settings.json` so every Claude Code tool call (bash, file reads, etc.) is scanned before input reaches the model and after output is returned.

### Codex — transparent proxy + CLI hook protection

LeakVault protects the Codex VS Code chat panel through two complementary layers.

#### Layer 1 — API proxy (VS Code panel, transparent)

When the extension activates it starts a local HTTP proxy on a random port (`127.0.0.1:<port>`) and writes one line to `~/.codex/config.toml`:

```toml
openai_base_url = "http://127.0.0.1:<port>/v1" # leakvault-proxy
```

Every request the Codex binary sends to the OpenAI API flows through this proxy first. The proxy deep-scans all JSON string fields in the request body, replaces any detected credentials with `GPG[<handle>]` markers, then forwards the clean payload to `api.openai.com`. The redaction is **transparent** — Codex receives the model response normally and you see no blocking or interruption.

When the extension deactivates the `openai_base_url` line is removed so Codex talks to OpenAI directly again.

#### Layer 2 — config.toml hooks (CLI, TUI, all surfaces)

LeakVault also appends `[[hooks.PreToolUse]]` and `[[hooks.PostToolUse]]` entries (inside a sentinel-delimited managed block) to `~/.codex/config.toml`. These fire for **every** Codex surface — the VS Code panel, `codex exec`, the interactive TUI — and cover tool inputs/outputs that the API proxy does not see:

- **`PreToolUse`** — deep-redacts tool input fields and lets the call proceed with clean values
- **`PostToolUse`** — warning-only notification when tool output contains credentials

Direct config-level hooks bypass the plugin trust system entirely, so they take effect immediately with no per-session approval prompt.

#### Why two layers?

The Codex `UserPromptSubmit` hook can block a prompt but **cannot rewrite it** — confirmed from the open-source Codex hook schema (`UserPromptSubmitHookSpecificOutputWire` has no `updatedPrompt` field). The API proxy is the only mechanism that allows transparent prompt modification for the VS Code panel.
---

## Vault storage

Intercepted credentials are encrypted and stored in `~/.leakvault/` (configurable).

- **Encryption:** AES-256-GCM with a 12-byte random IV and 16-byte auth tag per entry
- **Key storage:** The encryption key is kept in VS Code's `SecretStorage` (OS keychain on desktop)
- **Handles:** Derived as the first 12 hex characters of a SHA-256 hash of the plaintext — deterministic so the same secret always maps to the same handle

View stored handles any time:
- **LeakVault: Open Vault** command — shows a quick-pick list of handles and when they were stored
- `@leakvault /vault` in chat

---

## Commands

| Command | What it does |
|---------|-------------|
| `LeakVault: Scan & Redact Clipboard` | Scans clipboard text and replaces it with the redacted version |
| `LeakVault: Scan & Redact Selection` | Scans the selected editor text and redacts it in place |
| `LeakVault: Open Vault` | Shows stored credential handles in a quick-pick panel |
| `LeakVault: Toggle Protection` | Enables or disables credential interception globally |
| `LeakVault: Install Copilot Chat Hooks` | Manually (re)installs Claude Code and Codex CLI hooks |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `leakvault.enabled` | `true` | Enable or disable credential interception |
| `leakvault.notifyOnDetection` | `true` | Show a warning notification when credentials are redacted |
| `leakvault.autoInstallHooks` | `true` | Automatically configure Claude Code / Codex CLI hooks on activation |
| `leakvault.vaultDir` | `~/.leakvault` | Custom path for the encrypted vault directory |

---

## Requirements

- VS Code 1.120 or later
- GitHub Copilot (for the `@leakvault` chat participant)
- Claude Code CLI (optional, for hook-based protection)
- Codex CLI (optional, for hook-based protection)

---

## Privacy

LeakVault processes everything **locally**. No data is sent to any LeakVault server. The only network traffic is the already-redacted message going to whichever AI provider you were already using.

---

## License

MIT
