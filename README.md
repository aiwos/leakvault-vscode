# LeakVault — AI Credential Guard

**Stop your passwords and API keys from reaching AI chat servers.**

LeakVault sits between you and the AI. When a message or tool call would carry a credential, it scans the text, encrypts the secret to a local vault, and replaces it with a safe handle like `GPG[3f7a9c12b401]`. The AI provider never sees the real value.

The whole thing is one VS Code extension plus one small Node hook script — no proxies, no network rewiring, no extra services.

---

## How it works

LeakVault registers file-based hooks in two configs:

- `~/.claude/settings.json` — Claude Code (CLI and VS Code panel)
- `~/.codex/config.toml`    — Codex (CLI, TUI, and VS Code panel)

Both call the same script: `~/.leakvault/hook.js`.

| Hook event       | What LeakVault does                                                                  |
|------------------|---------------------------------------------------------------------------------------|
| `PreToolUse`     | Deep-redacts every string field in the tool input and **lets the call proceed**       |
| `UserPromptSubmit` | **Blocks** the prompt and returns a paste-ready redacted version in the block reason |
| `PostToolUse`    | Warning-only system message when tool output contains a credential                    |

### Why prompts are blocked instead of redacted

Both Claude Code and Codex expose hook outputs that can rewrite **tool inputs** (`hookSpecificOutput.updatedInput`) but not **user prompts**. The Codex binary's wire schema for `UserPromptSubmitHookSpecificOutputWire` declares `additionalProperties: false` and accepts only `hookEventName` + `additionalContext`. There is currently no `updatedPrompt` field on either platform.

Without an API to rewrite the prompt, the only way to keep cleartext credentials out of the model is to refuse the prompt. The block message contains the paste-ready redacted version so you can re-submit it with one keystroke.

When `updatedPrompt` ships, the prompt path will switch to redact-and-allow too.

---

## Detected credential types

| Type | Example |
|------|---------|
| AWS Access Key ID | `AKIA…` / `ASIA…` (20 chars) |
| AWS Secret Access Key | `aws_secret_access_key = <40-char value>` |
| GitHub PAT | `ghp_…`, `github_pat_…`, `gho_…`, `ghs_…`, `ghr_…` |
| OpenAI key | `sk-…` / `sk-proj-…` |
| Anthropic key | `sk-ant-api…` / `sk-ant-admin01-…` |
| Stripe key | `sk_live_…`, `sk_test_…`, `rk_live_…`, `rk_test_…` |
| JWT | `eyJ….<payload>.<signature>` |
| npm token | `npm_…` (36 chars) |
| Slack token | `xoxb-…`, `xoxa-…`, `xoxp-…`, `xoxr-…`, `xoxs-…` |
| Slack webhook URL | `https://hooks.slack.com/services/…` |
| Google API key | `AIza…` (39 chars) |
| DB connection URL | `postgres://user:GPG[485995535a01]@host` — only the password segment is redacted |
| Generic `key = value` | `password`, `secret`, `api_key`, `auth_token`, `access_token`, `private_key` with values ≥ 12 chars |
| Natural language passwords | `my password is GPG[16726f90cfa7]`, `password is …` |
| High-entropy tokens | 16–64 character tokens with Shannon entropy ≥ 3.5 bits/char and 3+ character classes — catches unknown / custom tokens |

---

## Commands

| Command | What it does |
|---------|-------------|
| `LeakVault: Scan & Redact Clipboard` | Scans clipboard text and replaces it with the redacted version |
| `LeakVault: Scan & Redact Selection` | Scans the selected editor text and redacts it in place |
| `LeakVault: Open Vault` | Shows stored credential handles in a quick-pick panel |
| `LeakVault: Toggle Protection` | Enables or disables credential interception globally |
| `LeakVault: Install Copilot Chat Hooks` | Manually (re)installs Claude Code and Codex CLI hooks |

### @leakvault chat participant (Copilot Chat)

Type `@leakvault` in GitHub Copilot Chat to route your message through LeakVault before it reaches the model.

```
@leakvault Here is my config: DATABASE_URL=postgres://admin:s3cr3t@db.prod.example.com/app
```

LeakVault redacts the password and forwards the safe version.

**Slash commands:**
- `@leakvault /scan` — explicitly scan and redact before answering
- `@leakvault /vault` — list all credential handles stored in the vault

#### Known gap: plain Copilot Chat (no `@leakvault`)

The VS Code public extension API exposes no pre-submit hook for arbitrary chat input — third-party participants are only invoked on explicit `@`-mention. For plain Copilot Chat, either prefix with `@leakvault` or run **LeakVault: Scan & Redact Clipboard** before pasting.

For Claude Code and Codex this gap does not exist — both honor the file-based hooks LeakVault registers automatically.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `leakvault.enabled` | `true` | Enable LeakVault credential interception |
| `leakvault.notifyOnDetection` | `true` | Show a notification when credentials are detected and redacted |
| `leakvault.autoInstallHooks` | `true` | Automatically configure Claude Code / Codex hooks on activation |
| `leakvault.vaultDir` | `~/.leakvault` | Custom path for the encrypted vault directory |

---

## Vault storage

Intercepted credentials are encrypted and stored in `~/.leakvault/`.

- **Encryption:** AES-256-GCM with a 12-byte random IV and 16-byte auth tag per entry
- **Key storage:** Kept in VS Code's `SecretStorage` (OS keychain on desktop)
- **Handles:** First 12 hex characters of `GPG[1bfff720f7ac]` — deterministic, so the same secret always maps to the same handle
- **Permissions:** Vault directory is `0700`, individual files are `0600`

---

## Requirements

- VS Code 1.120 or later
- GitHub Copilot (for the `@leakvault` chat participant)
- Claude Code CLI (optional, for hook-based protection)
- Codex CLI or Codex VS Code panel (optional, for hook-based protection)

---

## Privacy

LeakVault processes everything **locally**. No data is sent to any LeakVault server. The only network traffic is the already-redacted message going to whichever AI provider you were already using.

---

## License

MIT
