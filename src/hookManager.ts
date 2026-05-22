import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Path to the bundled standalone hook script that gets written alongside
// the extension-managed settings.
const HOOK_DEST = path.join(os.homedir(), '.leakvault', 'hook.js');

// Codex CLI config path. The Codex VS Code extension spawns its own bundled
// `codex` binary, but that binary reads ~/.codex/config.toml just like the
// standalone CLI does — so directly registering [[hooks.*]] here intercepts
// prompts from BOTH the CLI and the VS Code chat panel.
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

// Sentinel markers delimit the LeakVault-managed block in config.toml so we
// can rewrite or remove it without disturbing user-authored sections.
const CODEX_BLOCK_BEGIN = '# leakvault-hooks-begin (managed by LeakVault VS Code extension — do not edit)';
const CODEX_BLOCK_END = '# leakvault-hooks-end';

// Inline comment that tags the openai_base_url line we write, so we can
// locate and remove it precisely without touching any user-authored line.
const PROXY_URL_TAG = '# leakvault-proxy';

// -------------------------------------------------------------------------
// Read / write ~/.claude/settings.json safely
// -------------------------------------------------------------------------
function readSettings(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// -------------------------------------------------------------------------
// Build the hook entry object for Claude Code settings.json.
// Claude Code requires the nested `{matcher?, hooks: [{type, command}]}`
// shape — flat `{type, command, matcher}` entries are silently dropped and
// `/doctor` reports them as malformed (AGENT_NOTES bug #1).
// -------------------------------------------------------------------------
interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

function claudeHookEntry(matcher?: string): ClaudeHookEntry {
  const inner = { type: 'command', command: `"${HOOK_DEST}"` };
  return matcher ? { matcher, hooks: [inner] } : { hooks: [inner] };
}

// True when a hooks-event entry was installed by a previous LeakVault
// release. Handles both the new nested shape and the legacy flat shape so
// upgrading from <= 0.1.6 cleans up the old broken entries.
function isLeakVaultEntry(e: unknown): boolean {
  const rec = e as Record<string, unknown> | null;
  if (!rec) return false;
  const flatCmd = rec['command'];
  if (typeof flatCmd === 'string' && flatCmd.includes('leakvault')) return true;
  const inner = rec['hooks'];
  if (Array.isArray(inner)) {
    for (const h of inner) {
      const cmd = (h as Record<string, unknown> | null)?.['command'];
      if (typeof cmd === 'string' && cmd.includes('leakvault')) return true;
    }
  }
  return false;
}

// -------------------------------------------------------------------------
// Build the LeakVault Codex hook block as inline TOML.
// Uses [[hooks.<EventName>]] array-of-tables syntax — natively supported by
// the bundled Codex binary, so the same hook fires for both `codex exec`
// (CLI) and the VS Code Codex chat panel.
// -------------------------------------------------------------------------
function buildCodexHookBlock(): string {
  const cmd = `${HOOK_DEST}`;
  return [
    CODEX_BLOCK_BEGIN,
    '[[hooks.UserPromptSubmit]]',
    '',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    `command = "${cmd}"`,
    'timeout = 30',
    'statusMessage = "LeakVault: scanning prompt for credentials"',
    '',
    '[[hooks.PreToolUse]]',
    'matcher = ".*"',
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = "${cmd}"`,
    'timeout = 30',
    'statusMessage = "LeakVault: scanning tool input for credentials"',
    '',
    '[[hooks.PostToolUse]]',
    'matcher = "^Bash$"',
    '',
    '[[hooks.PostToolUse.hooks]]',
    'type = "command"',
    `command = "${cmd}"`,
    'timeout = 30',
    'statusMessage = "LeakVault: scanning Bash output for credentials"',
    CODEX_BLOCK_END,
    '',
  ].join('\n');
}

// -------------------------------------------------------------------------
// Strip the LeakVault-managed block (between begin/end sentinels) from a
// TOML string. Also strips the legacy openai_base_url line and any legacy
// plugin/marketplace entries from earlier LeakVault versions so we don't
// leave a stale Codex proxy redirection behind.
// -------------------------------------------------------------------------
function stripLeakVaultBlock(content: string): string {
  let out = content;

  // Remove the sentinel-delimited managed block (any number of occurrences).
  const blockRe = new RegExp(
    `\\n?${escapeRegExp(CODEX_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_BLOCK_END)}\\n?`,
    'g',
  );
  out = out.replace(blockRe, '\n');

  // Remove any openai_base_url or chatgpt_base_url lines we wrote (legacy
  // v0.1.4 plain line, or the current tagged line). Leaving a stale one in
  // place would keep sending Codex traffic to a port that no longer exists.
  out = out.replace(/^openai_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');
  out = out.replace(/^chatgpt_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');

  // Remove legacy plugin/marketplace registrations + their trusted_hash
  // bookkeeping. Each [section] header runs until the next [header] or EOF.
  const legacySections = [
    /\n?\[marketplaces\.leakvault-local\][^\n]*\n(?:(?!\n\[)[\s\S])*/g,
    /\n?\[plugins\."leakvault-vscode@leakvault-local"\][^\n]*\n(?:(?!\n\[)[\s\S])*/g,
    /\n?\[hooks\.state\."leakvault-vscode@leakvault-local:[^"]*"\][^\n]*\n(?:(?!\n\[)[\s\S])*/g,
  ];
  for (const re of legacySections) out = out.replace(re, '');

  // Collapse runs of blank lines that the deletions may have produced.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------------------------------------------------------------
// Write [[hooks.*]] entries directly into ~/.codex/config.toml.
// Direct config.toml hooks bypass Codex's plugin trust system entirely
// (trust only applies to plugin-supplied hooks.json files) so they fire
// reliably for every originator — CLI, TUI, and the VS Code chat panel.
// -------------------------------------------------------------------------
function installCodexHooks(): void {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) {
    return; // Codex not installed — skip silently.
  }

  let content = '';
  try {
    content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
  } catch {
    return;
  }

  // Strip any previous LeakVault block / legacy proxy / legacy plugin entries
  // before appending the fresh managed block, so the install is idempotent.
  const cleaned = stripLeakVaultBlock(content);
  const trailing = cleaned.endsWith('\n') ? '' : '\n';
  const next = cleaned + trailing + '\n' + buildCodexHookBlock();

  if (next !== content) {
    fs.writeFileSync(CODEX_CONFIG_PATH, next, 'utf8');
  }
}

function uninstallCodexHooks(): void {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return;
  try {
    const content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
    const cleaned = stripLeakVaultBlock(content);
    if (cleaned !== content) {
      fs.writeFileSync(CODEX_CONFIG_PATH, cleaned, 'utf8');
    }
  } catch {
    // Best-effort cleanup
  }
}

// -------------------------------------------------------------------------
// Install / update hooks for both Claude Code (settings.json) and Codex
// (config.toml direct [[hooks.*]] registration).
// -------------------------------------------------------------------------
export function installHooks(hookScriptSource: string): { installed: boolean; message: string } {
  try {
    // Write the standalone hook.js to ~/.leakvault/
    const destDir = path.dirname(HOOK_DEST);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(HOOK_DEST, hookScriptSource, 'utf8');
    fs.chmodSync(HOOK_DEST, 0o755);

    const settings = readSettings();

    const hooks = (settings['hooks'] as Record<string, unknown[]>) ?? {};

    // UserPromptSubmit — always overwrite our entry. Drop any legacy or
    // duplicate LeakVault entries (flat OR nested shape) before re-adding
    // the canonical nested entry.
    const existingPrompt = (hooks['UserPromptSubmit'] as unknown[] | undefined) ?? [];
    const promptHooks: unknown[] = existingPrompt.filter((e) => !isLeakVaultEntry(e));
    promptHooks.push(claudeHookEntry());
    hooks['UserPromptSubmit'] = promptHooks;

    // PreToolUse — wildcard so the redact+allow path covers every tool.
    const existingPre = (hooks['PreToolUse'] as unknown[] | undefined) ?? [];
    const preHooks: unknown[] = existingPre.filter((e) => !isLeakVaultEntry(e));
    preHooks.push(claudeHookEntry('.*'));
    hooks['PreToolUse'] = preHooks;

    // PostToolUse — bash + execute matchers (notify-only).
    const existingPost = (hooks['PostToolUse'] as unknown[] | undefined) ?? [];
    const postHooks: unknown[] = existingPost.filter((e) => !isLeakVaultEntry(e));
    postHooks.push(claudeHookEntry('Bash'));
    postHooks.push(claudeHookEntry('execute'));
    hooks['PostToolUse'] = postHooks;

    settings['hooks'] = hooks;
    writeSettings(settings);

    // Also configure Codex if installed.
    installCodexHooks();

    return {
      installed: true,
      message: `LeakVault hooks installed in ${SETTINGS_PATH}\nHook script: ${HOOK_DEST}\nCodex hooks: ${fs.existsSync(CODEX_CONFIG_PATH) ? CODEX_CONFIG_PATH : '(Codex not installed)'}`,
    };
  } catch (err) {
    return {
      installed: false,
      message: `Failed to install hooks: ${String(err)}`,
    };
  }
}

// -------------------------------------------------------------------------
// Remove LeakVault entries from hooks (clean uninstall)
// -------------------------------------------------------------------------
export function uninstallHooks(): void {
  try {
    const settings = readSettings();
    const hooks = (settings['hooks'] as Record<string, unknown[]>) ?? {};

    for (const event of Object.keys(hooks)) {
      hooks[event] = (hooks[event] as unknown[]).filter((h) => !isLeakVaultEntry(h));
      if (hooks[event].length === 0) delete hooks[event];
    }

    settings['hooks'] = hooks;
    writeSettings(settings);
  } catch {
    // Best-effort cleanup — ignore errors
  }
  uninstallCodexHooks();
}

// -------------------------------------------------------------------------
// Write / remove the openai_base_url line that redirects Codex through the
// LeakVault local proxy.  The line is tagged with PROXY_URL_TAG so it can
// be found and replaced idempotently without touching user content.
// -------------------------------------------------------------------------
// -------------------------------------------------------------------------
// Write / remove the openai_base_url and chatgpt_base_url lines that redirect
// Codex through the LeakVault local proxy.
// - openai_base_url  → API-key auth mode (api.openai.com traffic)
// - chatgpt_base_url → ChatGPT account auth mode (chatgpt.com/backend-api)
//   Codex validates chatgpt_base_url as: HTTPS for chatgpt.com/staging, OR
//   HTTP/HTTPS for localhost — so http://127.0.0.1:<port> is accepted.
// -------------------------------------------------------------------------
export function installCodexProxyUrl(port: number): void {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return;
  try {
    let content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
    // Remove any previously written proxy URL lines first (idempotent).
    content = content.replace(/^openai_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');
    content = content.replace(/^chatgpt_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');
    const trailing = content.endsWith('\n') ? '' : '\n';
    content =
      content +
      trailing +
      `openai_base_url = "http://localhost:${port}/v1" ${PROXY_URL_TAG}\n` +
      `chatgpt_base_url = "http://localhost:${port}" ${PROXY_URL_TAG}\n`;
    fs.writeFileSync(CODEX_CONFIG_PATH, content, 'utf8');
  } catch {
    // Best-effort — if Codex config isn't writable, hooks still protect CLI.
  }
}

export function uninstallCodexProxyUrl(): void {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return;
  try {
    let content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
    const cleaned = content
      .replace(/^openai_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '')
      .replace(/^chatgpt_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');
    if (cleaned !== content) {
      fs.writeFileSync(CODEX_CONFIG_PATH, cleaned, 'utf8');
    }
  } catch {
    // Best-effort cleanup
  }
}

export { SETTINGS_PATH, HOOK_DEST, CODEX_CONFIG_PATH };
