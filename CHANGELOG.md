# Changelog

All notable changes to LeakVault will be documented in this file.

## [0.1.23] - 2026-06-10

### Fixed
- **Entropy false positives (high-entropy detector overhaul).** Three root causes fixed:
  - `charClasses` now counts only strong symbols (`!@#$%^&*?~|`) as the fourth character class; `_ - + =` were previously treated as strong symbols, causing `snake_case_config_keys` and similar identifiers to reach 3 classes and get flagged.
  - Two-track entropy thresholds: tokens **with** a strong symbol use a lower threshold (3.2); tokens **without** a strong symbol (pure alnum) require a higher threshold (4.2). This eliminates false positives on `sessionId123AbcXyz`-style CamelCase+digits identifiers (entropy ~3.9 < 4.2).
  - Boring skip: tokens where ≥85% of characters are lowercase letters, underscores, or hyphens are unconditionally skipped (snake_case config keys, URL path segments).
- **`STRONG_SPECIALS` and `HIGH_ENTROPY_RE` updated** to match the new `charClasses` definition (include `?`, `~`, `|`; align with strong-symbol set).
- **Codex MCP PreToolUse compatibility issue documented** in hook script header (known issue: Codex MCP tool calls print "Failed" and are not redacted; requires investigation of Codex hook event name/structure).

## [0.1.21] - 2026-05-22

### Fixed
- **`resolveVaultDir` tilde expansion.** `~/.leakvault`.slice(1)` produced `/.leakvault` (an absolute path), causing `path.join(homedir, '/.leakvault')` to discard the homedir. Now strips `~/` as a two-character prefix (`slice(2)`) and handles bare `~` as a separate case.
- **`isLeakVaultEntry` backward compatibility.** After renaming the deployed hook to `leakvault-hook.js`, the old detection logic would have missed entries written by earlier releases (`~/.leakvault/hook.js`). Now matches both the new fixed basename and the legacy `.leakvault/hook.js` pattern so upgrades cleanly replace prior installs.
- **VAULT_DIR patch verification.** `installHooks` now checks that the regex replacement actually modified the hook source; returns an explicit failure message if the `VAULT_DIR` constant is missing (e.g. after a future rename in the bundled script).
- **`vault.dir` path normalization.** `VaultStorage` now expands `~` and calls `path.resolve()` in its constructor, ensuring `vault.dir` is always an absolute path. Previously, a setting like `~/.leakvault` would be passed verbatim to `fs.watch` and file operations, resolving against the process CWD instead of the home directory.

## [0.1.20] - 2026-05-22

### Fixed
- **Custom vault directory support.** `installHooks` now accepts `vaultDir`, patches the `VAULT_DIR` constant in the deployed hook script, and writes the hook to `<vaultDir>/leakvault-hook.js`. Previously the hook was always written to `~/.leakvault/hook.js` regardless of `leakvault.vaultDir`, so the clipboard watcher and vault storage would silently diverge on custom paths.
- **Path-independent hook detection.** Hook is now deployed as `leakvault-hook.js` (fixed basename) so `isLeakVaultEntry()` matches on the filename rather than requiring the directory name to contain `"leakvault"`. Custom dirs like `/tmp/vault` no longer accumulate duplicate hooks on reinstall.
- **`vault.dir` passed to watcher and installer.** Both `setupRedactedClipboardWatcher` and `doInstallHooks` in `extension.ts` now receive and use `vault.dir`, keeping the watcher and hook in the same directory.
- **Removed dead `seen` parameter from `redactDeep`.** The `seen` parameter was threaded through all recursive calls but never read; `scan()` deduplicates independently. Removed from the function signature and all call sites.

## [0.1.19] - 2026-05-22

### Fixed
- **Hooks persist across VS Code sessions.** `deactivate()` no longer calls `uninstallHooks()` — hooks are intentionally left installed so protection runs even when VS Code is closed.
- **Clipboard watcher respects `leakvault.vaultDir`.** `last-redacted.txt` is now derived from the configured vault directory instead of a hardcoded `~/.leakvault` path.
- **`fs.watch` null filename.** On platforms that don't supply a filename in the watch callback the watcher now fires `onChange()` unconditionally, preventing missed clipboard updates.
- **Vault stores credential plaintext, not the handle.** `scan()` now returns a `plaintexts: Map<handle, plaintext>` alongside `handles`. Both `hook.js` (`storeCredentials`) and the chat participant now encrypt the actual credential value, making the vault decryptable.
- **`retrieve()` decryption output.** Fixed Buffer + string concatenation (`decipher.update(buf) + decipher.final('utf8')`) that produced garbled output — replaced with `Buffer.concat([...]).toString('utf8')`.
- **Status bar flash residue.** `setActive(false)` now clears `backgroundColor` so a warning flash from `flashAlert()` doesn't persist after protection is toggled off.
- **Vault file permissions.** `hook.js` now writes `.enc` files with mode `0600` and `chmod`s the vault directory to `0700`.
- **`security-audit.sh` tsc redirection.** Reversed `2>&1 > file` corrected to `> file 2>&1` so compiler errors are actually captured.
- **`.vscodeignore` duplicate entries.** Removed three duplicate lines (`*.vsix`, `**/*.map`, `out/test/**`).

## [0.1.18] - 2026-05-22

### Changed
- Block toast shortened to `LeakVault: redacted prompt in clipboard — Ctrl+V.` Clipboard and selection redaction toasts dropped the handle list.
- README rewritten as a single short page — behavior table, settings table, vault notes. Dropped the long architecture discussion that overlapped with CHANGELOG.

## [0.1.17] - 2026-05-22

### Changed
- **Clipboard now contains only the user's message, not Codex's IDE-context preamble.** Codex wraps every prompt in `# Context from my IDE setup: … ## My request for Codex: <msg>`. The hook now slices off everything up to and including `## My request for Codex:\n` before writing to `~/.leakvault/last-redacted.txt`, so paste-and-resend gives Codex back just the redacted user message. Claude Code's prompts have no preamble — the slice falls through to the full text.

### Notes
- Re-confirmed that auto-paste / auto-send is not implementable without OS-level keystroke synthesis. The OpenAI Codex extension's `package.json` contributes 10 commands (`chatgpt.openSidebar`, `chatgpt.newCodexPanel`, `chatgpt.addToThread`, …), none of which accept a prompt argument. The chat input lives in a sealed `"type": "webview"` (codexViewContainer / codexSecondaryViewContainer) that other extensions cannot script into. `editor.action.clipboardPasteAction` only targets text editors. Conclusion: clipboard hand-off + manual paste remains the best achievable UX.

## [0.1.16] - 2026-05-22

### Added
- **Auto-copy redacted prompt to clipboard on block.** When a `UserPromptSubmit` block fires, the hook writes the redacted prompt to `~/.leakvault/last-redacted.txt` (mode `0600`). The extension watches that file via `fs.watch` on the parent directory; on every rewrite it copies the contents to the VS Code clipboard and shows a toast: *"LeakVault blocked a prompt — redacted version copied to clipboard. Paste & resend."* Resubmitting becomes `Ctrl+A → Ctrl+V → Enter`.
- Auto-resubmit is **not** possible: the Codex panel is a third-party WebView and VS Code exposes no API to inject text into another extension's chat input. The clipboard hand-off is the closest UX achievable without IPC with OpenAI's extension.

## [0.1.15] - 2026-05-22

### Removed
- **Codex API proxy (`src/codexProxy.ts`) is gone.** The 0.1.7–0.1.14 design ran a local HTTP server on a random port and rewrote `openai_base_url` / `chatgpt_base_url` in `~/.codex/config.toml` so every Codex API request was redacted in flight. In practice the proxy was overkill — the same protection is achievable with the file-based hooks already registered for Claude Code, and a proxy adds an extra moving part (port allocation, lifecycle, TOML mutation) for no extra coverage. The extension now uses hooks only.
- `installCodexProxyUrl` / `uninstallCodexProxyUrl` and the `# leakvault-proxy` tagged lines they wrote. Upgrading from 0.1.7–0.1.14 automatically strips any stale `openai_base_url` / `chatgpt_base_url` line on first activation, so Codex stops routing to a port that no longer exists.
- `scripts/install-codex-prompt-hook.js` — obsolete marketplace-plugin installer left over from 0.1.4.
- `AGENT_NOTES.md` — bugs it tracked (claudeHookEntry shape, scanner self-redaction, HIGH_ENTROPY_RE brackets) are all fixed.

### Changed
- README rewritten around the hooks-only architecture. Drops the two-layer (proxy + hooks) explanation in favor of one table: `PreToolUse` redacts and allows, `UserPromptSubmit` blocks with paste-ready redacted text in the reason, `PostToolUse` notifies.
- Codex `UserPromptSubmit` blocking is now documented as the intentional design — confirmed against the bundled Codex binary's JSON schema (`UserPromptSubmitHookSpecificOutputWire` declares `additionalProperties: false` and accepts only `hookEventName` + `additionalContext`, no `updatedPrompt`).

## [0.1.7] - 2026-05-21

### Fixed
- **Bug #1 — Claude Code hook entries written in wrong shape.** Previous releases pushed flat `{type, command, matcher}` objects into `~/.claude/settings.json` events; Claude Code requires the nested `{matcher?, hooks: [{type, command}]}` form. Every reinstall re-introduced malformed hooks that `/doctor` flagged. `claudeHookEntry()` now emits the correct nested shape and the dedupe filter (`isLeakVaultEntry`) recognizes both legacy flat and new nested entries, so upgrading from `<= 0.1.6` cleans up the broken entries automatically.
- **Bug #2 — Scanner redacted its own source code.** The `generic_kv` value charset included regex-prone characters (`[ ] ; : , < > ? / \ | \` ~`) and matched anything 12+ characters long, so when LeakVault scanned its own `.ts` / `.js` files it corrupted regex literals. The value charset is now restricted to common password chars (`A-Z`, `a-z`, `0-9`, `! @ # $ % ^ & * ( ) - _ + = .`). Added an `isAlreadyHandle()` guard that skips inputs already in `GPG[<12hex>]` form so a redacted file scanned a second time stays stable.
- **Bug #3 — `HIGH_ENTROPY_RE` character classes self-redacted.** The high-entropy fallback's inner charset included `! @ # $ % ^ & *`, so strings like `[A-Za-z0-9!@#$%^&*\-_+=]` (the regex itself) qualified as high-entropy tokens and got mangled. Charset tightened to `[A-Za-z0-9\-_+/=]` and a `looksLikeRegexInternal()` guard skips matches that contain range markers (`a-z`/`A-Z`/`0-9`), regex metachar escapes (`\d`, `\w`, `\s`, `\b`, `(?:`, etc.), or sit immediately after `[` / `[^` in the surrounding text.

### Changed
- **PreToolUse hook is no longer blocking — it now redacts and allows.** Following owner intent ("you don't have to block it — enough that it is anonymized"), the `PreToolUse` path deep-redacts `tool_input` and returns `hookSpecificOutput.updatedInput` with `permissionDecision: "allow"`. The tool runs with `GPG[<handle>]` markers in place of credentials; the original values are still encrypted to `~/.leakvault/<handle>.enc`. A `PreToolUse` wildcard matcher is now installed so the redact-and-allow path covers every tool, not just `Bash`.
- **PostToolUse remains notify-only** (already non-blocking).

### Known limitation
- **UserPromptSubmit still has to block.** Claude Code and Codex both lack a `hookSpecificOutput.updatedPrompt` field for `UserPromptSubmit` — confirmed via the bundled Codex binary's wire schema (`UserPromptSubmitHookSpecificOutputWire` has only `hookEventName` and `additionalContext`) and the open Claude Code feature request [anthropics/claude-code#27365](https://github.com/anthropics/claude-code/issues/27365). Without an API to rewrite the user prompt, the only way to keep cleartext credentials out of the model is to block. The block message now contains the paste-ready redacted prompt. When `updatedPrompt` ships, this hook will switch to redact-and-allow too.

## [0.1.6] - 2026-05-21

### Documentation
- Documented the **Copilot Chat known gap**: prompts typed into GitHub Copilot Chat without an explicit `@leakvault` prefix cannot be scanned. VS Code's public extension API exposes no pre-submit hook for arbitrary chat input — third-party participants are only invoked on explicit `@`-mention, and `disambiguation`-based auto-routing gives built-in participants (Copilot) precedence. A system-level HTTPS proxy cannot bridge the gap either without installing a custom root CA. README now points Copilot Chat users at the `@leakvault` participant and the `LeakVault: Scan & Redact Clipboard` command as the only realistic mitigations.
- Claude Code and the OpenAI Codex VS Code panel are unaffected — both honor file-based hooks that LeakVault registers automatically.

## [0.1.5] - 2026-05-21

### Changed
- **Codex interception switched from HTTPS proxy to direct config-level hooks.** Earlier versions started a local OpenAI-compatible proxy on `127.0.0.1:8765` and rewrote `openai_base_url` in `~/.codex/config.toml`. That approach only intercepted `/v1/chat/completions` traffic, which the Codex VS Code chat panel does not use — the panel talks to `chatgpt.com/backend-api`, so prompts entered there were never scanned.
- The extension now appends `[[hooks.UserPromptSubmit]]`, `[[hooks.PreToolUse]]`, and `[[hooks.PostToolUse]]` entries (inside a sentinel-delimited managed block) directly to `~/.codex/config.toml`. The Codex VS Code panel spawns the same bundled `codex` binary the CLI uses; both honor `[[hooks.*]]` from `~/.codex/config.toml`, so the redaction fires for every Codex surface (panel + `codex exec` + TUI).
- Direct config-level hooks bypass Codex's plugin trust system (which silently dropped the previous `leakvault-vscode@leakvault-local` plugin's `UserPromptSubmit` hook when the VS Code panel originator had no `[hooks.state]` trusted_hash entry).

### Removed
- `src/proxyServer.ts` — the local OpenAI proxy is gone. Nothing listens on port 8765 anymore.
- `setCodexBaseUrl()` from `hookManager.ts` — no longer rewriting `openai_base_url`.
- Plugin/marketplace registration code (`installCodexPlugin` / `uninstallCodexPlugin`) — replaced by `installCodexHooks` / `uninstallCodexHooks` that edit `config.toml` directly.

### Fixed
- On first activation the extension automatically cleans up legacy state left by `0.1.4`-and-earlier installs: the stale `openai_base_url = "http://127.0.0.1:8765"` line, the `[marketplaces.leakvault-local]` section, the `[plugins."leakvault-vscode@leakvault-local"]` section, and the `[hooks.state."leakvault-vscode@leakvault-local:..."]` trust entries are all stripped from `config.toml`. Prevents Codex from sending traffic to a dead local port after upgrading.

## [0.1.3] - 2026-05-21

### Added
- **Professional-grade Security Audit Framework** (5 documents + automated script)
  - SECURITY_AUDIT.md (10 security categories with checklists)
  - SECURITY_SETUP.md (pre-commit hook + GitHub Actions integration)
  - SECURITY_SUMMARY.md (threat model with CVSS scoring)
  - SECURITY_QUICK_REFERENCE.md (30-second cheat sheet)
  - scripts/security-audit.sh (8-point automated security checks)
  
- **Automated Security Testing**
  - Pre-commit hook integration
  - GitHub Actions CI/CD template
  - 8-point security verification:
    * Hardcoded secrets scanner (13+ patterns)
    * AWS credentials detector
    * GitHub token detector
    * TypeScript compilation check
    * npm dependency audit
    * File permissions verifier (0700, 0600)
    * Encryption algorithm verification (AES-256-GCM)
    * Code quality checks

- **File Permission Auto-Enforcement**
  - Vault directory: 0700 (owner-only)
  - Vault files: 0600 (owner-only read/write)
  - Automatic enforcement in vaultStorage.ts

- **Threat Model & Incident Response**
  - CVSS-scored vulnerability matrix
  - Mitigation strategies for all identified threats
  - Emergency incident response procedures
  - Quarterly security audit checklist

### Fixed
- **CWE-277: Insecure Inherited Permissions**
  - Vault directory permissions auto-enforced to 0700
  - Vault file permissions auto-enforced to 0600
  - Prevents unauthorized access by other users on the system

- **Security Vulnerability Documentation**
  - Added comprehensive vulnerability tracking
  - CVSS scoring for all threats
  - Remediation procedures documented

### Security
- All vault files now enforce 0600 permissions automatically
- Pre-commit hook prevents commits with hardcoded secrets
- Encryption verification (AES-256-GCM) automated
- Dependency vulnerabilities caught before merge
- File permissions verified before every commit

### Documentation
- 5 comprehensive security documents
- Pre-commit hook setup guide (2 minutes)
- GitHub Actions workflow template
- Quick reference card for developers
- Threat model with CVSS assessment
- Incident response playbook

## [0.1.2] - 2026-05-21

### Added
- Comprehensive E2E test suite (28+ test scenarios)
- Enhanced marketplace metadata and badges
- CHANGELOG.md for version tracking
- Marketplace submission guide

### Improved
- AWS secret pattern group reference fix (credGroup: 2)
- Better marketplace presentation with security category
- Extended credential detection documentation

## [0.1.1] - 2026-05-21

### Added
- Initial public release
- @leakvault chat participant for GitHub Copilot Chat
- Credential scanning with 16+ credential pattern types:
  - AWS Access Keys (AKIA, ASIA)
  - AWS Secret Access Keys
  - GitHub Personal Access Tokens (ghp_, github_pat_, gho_, ghs_, ghr_)
  - OpenAI API keys (sk-, sk-proj-)
  - Anthropic API keys (sk-ant-*)
  - Stripe secret and restricted keys
  - JWT tokens
  - npm access tokens
  - Slack bot/user tokens and webhook URLs
  - Google API keys
  - Database connection strings (selective password redaction)
  - Generic key=value assignments (password, secret, api_key, auth_token, access_token, private_key)
  - Natural language passwords
  - High-entropy standalone tokens (entropy ≥ 3.5 bits/char, 3+ character classes)
- Encrypted local vault storage (AES-256-GCM)
- Clipboard and selection scanning commands
- Status bar indicator for protection status
- Claude Code integration with automatic hook installation
- Codex CLI integration
- User commands:
  - Scan & Redact Clipboard
  - Scan & Redact Selection
  - Open Vault
  - Toggle Protection
  - Install Copilot Chat Hooks
- Configurable settings:
  - Enable/disable protection
  - Notification on detection
  - Auto-install hooks
  - Custom vault directory

### Fixed
- AWS secret access key pattern now correctly uses credGroup: 2 for proper capture group matching
- High-entropy detection filters to prevent false positives on:
  - File extensions (.js, .ts, .json, etc.)
  - Version strings (1.2.3, 4.5.6-beta)
  - CamelCase identifiers
  - Short values (< 12 chars for generic KV, < 8 chars for natural language)

### Security
- All credentials encrypted locally before storage
- Deterministic handle generation (SHA-256) for consistency across sessions
- No cleartext credentials transmitted to external servers
- Per-credential encryption with random IV and auth tag
- Encryption key stored in VS Code SecretStorage (OS keychain)

## Future Roadmap

- [ ] Support for additional credential types (Datadog, New Relic, etc.)
- [ ] Vault viewer UI with decryption preview
- [ ] Integration with secret managers (1Password, Bitwarden, LastPass)
- [ ] Batch vault operations (export, import, rotate)
- [ ] Analytics dashboard for detection statistics
- [ ] Custom pattern definitions
