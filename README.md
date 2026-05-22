# LeakVault — AI Credential Guard

Stops passwords and API keys from reaching AI chat servers. Hooks into Claude Code and the OpenAI Codex VS Code panel, scans every prompt and tool call, and replaces detected credentials with handles like `GPG[3f7a9c12b401]` before they leave your machine. Originals are encrypted to `~/.leakvault/`.

## Behavior

| Event | What LeakVault does |
|-------|---------------------|
| `PreToolUse` | Deep-redacts tool input, allows the call (`hookSpecificOutput.updatedInput`) |
| `UserPromptSubmit` | Blocks the prompt, copies the redacted version to the clipboard — paste & resend |
| `PostToolUse` | Warning-only system message on credential-bearing tool output |

`UserPromptSubmit` blocks because neither Claude Code nor Codex exposes an `updatedPrompt` field on the hook output schema today. The clipboard hand-off is the closest UX achievable without OS-level keystroke synthesis.

## Detected credentials

AWS keys, GitHub PATs, OpenAI / Anthropic / Stripe keys, JWTs, npm tokens, Slack tokens & webhooks, Google API keys, DB connection-string passwords, generic `password = …` / `secret = …` / `api_key = …` assignments, natural-language passwords, and high-entropy 16–64 char tokens.

## Commands

| Command | Action |
|---------|--------|
| `LeakVault: Scan & Redact Clipboard` | Redact the clipboard contents |
| `LeakVault: Scan & Redact Selection` | Redact the current editor selection |
| `LeakVault: Open Vault` | Show stored credential handles |
| `LeakVault: Toggle Protection` | Enable / disable interception |
| `LeakVault: Install Copilot Chat Hooks` | Re-install Claude Code / Codex hooks |

Type `@leakvault` in GitHub Copilot Chat to route a message through LeakVault. Without an `@`-mention the VS Code API gives third parties no hook on plain Copilot Chat — use the clipboard command instead.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `leakvault.enabled` | `true` | Master switch |
| `leakvault.notifyOnDetection` | `true` | Toast on every redaction / block |
| `leakvault.autoInstallHooks` | `true` | Install hooks into `~/.claude/settings.json` and `~/.codex/config.toml` on activation |
| `leakvault.vaultDir` | `~/.leakvault` | Vault path |

## Vault

AES-256-GCM, 12-byte IV + 16-byte auth tag per entry. Key stored in VS Code's `SecretStorage`. Handles are `sha256(plaintext)[0:12]` — deterministic. Vault dir `0700`, files `0600`.

## Privacy

Everything runs locally. The only outbound traffic is the already-redacted message going to whichever AI provider you were already using.

MIT.
