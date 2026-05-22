# Agent Notes — leakvault-vscode

## Owner feedback (2026-05-21)

> "you don't have to block it — enough that it is anonymized"

The core behavioral change requested: **detect and redact is sufficient; do not block the underlying tool call / prompt submission.** The current hook.js should replace credentials with `GPG[<handle>]` markers in the output/input stream and let execution continue. Blocking (non-zero exit, halting the tool) is not the intended UX.

---

## Known bugs to fix

### 1. Hook format written by `installHooks()` is wrong

**File:** `src/hookManager.ts`, function `claudeHookEntry()` (line 43) and callers (lines 197–211)

The helper builds flat objects `{ type, command, matcher }` and pushes them directly into the event array. Claude Code requires the nested format:

```json
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "..." }]
}
```

Every time a user installs/re-installs the extension this bug re-introduces malformed hooks that `/doctor` flags. The fix is to rewrite `claudeHookEntry()` to return `{ matcher, hooks: [{ type, command }] }` and drop the flat-object approach.

### 2. Credential scanner redacts its own source code

**File:** `src/credentialScanner.ts`

The `generic_kv` pattern (line ~63) and the `HIGH_ENTROPY_RE` fallback (line ~108) are broad enough to match base64-encoded segments inside regex character classes and even method-call identifiers in the scanner's own source. When LeakVault reads its own files (or any TypeScript source with complex regexes), it corrupts the content with `GPG[...]` markers.

Fixes to consider:
- Exclude content inside regex literals `/…/g` from scanning.
- Tighten `HIGH_ENTROPY_RE` — require at least one digit AND one special char from a stricter set before treating a token as high-entropy.
- Add a "skip if already a GPG handle" guard so `GPG[abc123]` is never re-scanned.

### 3. `HIGH_ENTROPY_RE` character-class brackets are self-redacted

The character class in `HIGH_ENTROPY_RE` (line ~108) uses `[A-Za-z0-9...]` but the scanner itself redacts parts of that literal when reading the file — the `[` and `]` inside the class definition get treated as token boundaries. This is a symptom of bug #2 but worth calling out separately because it means the scanner is silently broken on any file that contains raw bracket-delimited character classes.

---

## Architecture note

`hookManager.ts` writes to two separate configs:
- `~/.claude/settings.json` — Claude Code hooks
- `~/.codex/config.toml` — Codex CLI/VS Code panel hooks

Both need the format fix from bug #1. The Codex TOML block in `buildCodexHookBlock()` already uses the correct `[[hooks.UserPromptSubmit.hooks]]` sub-table pattern, so only the JSON side is broken.
