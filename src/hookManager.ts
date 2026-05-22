import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_DEST = path.join(os.homedir(), '.leakvault', 'hook.js');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const CODEX_BLOCK_BEGIN = '# leakvault-hooks-begin (managed by LeakVault VS Code extension — do not edit)';
const CODEX_BLOCK_END = '# leakvault-hooks-end';

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

interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

function claudeHookEntry(matcher?: string): ClaudeHookEntry {
  const inner = { type: 'command', command: `"${HOOK_DEST}"` };
  return matcher ? { matcher, hooks: [inner] } : { hooks: [inner] };
}

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
// Codex TOML block — direct [[hooks.*]] registration in ~/.codex/config.toml.
// Fires for every Codex surface (VS Code panel, CLI, TUI).
//
// UserPromptSubmit: blocks prompts containing credentials and surfaces the
//   redacted version in the block reason. Codex's hook schema has no
//   `updatedPrompt` field (confirmed in the bundled binary's JSON schema —
//   `UserPromptSubmitHookSpecificOutputWire` only accepts `hookEventName`
//   and `additionalContext`), so blocking is the only way to keep cleartext
//   credentials out of the model.
// PreToolUse: redacts `tool_input` and allows the call to proceed.
// PostToolUse: notify-only on Bash output.
// -------------------------------------------------------------------------
function buildCodexHookBlock(): string {
  const cmd = HOOK_DEST;
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

// Strip the LeakVault-managed block and any legacy proxy/plugin entries
// left behind by older releases.
function stripLeakVaultBlock(content: string): string {
  let out = content;

  const blockRe = new RegExp(
    `\\n?${escapeRegExp(CODEX_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_BLOCK_END)}\\n?`,
    'g',
  );
  out = out.replace(blockRe, '\n');

  // Legacy v0.1.4–v0.1.14 proxy URL lines — remove on upgrade so Codex stops
  // routing to a dead local port.
  out = out.replace(/^openai_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');
  out = out.replace(/^chatgpt_base_url\s*=\s*"[^"\n]*"[^\n]*\n?/m, '');

  // Legacy v0.1.4 marketplace/plugin sections.
  const legacySections = [
    /\n?\[marketplaces\.leakvault-local\][^\n]*\n(?:(?!\n\[)[\s\S])*/g,
    /\n?\[plugins\."leakvault-vscode@leakvault-local"\][^\n]*\n(?:(?!\n\[)[\s\S])*/g,
    /\n?\[hooks\.state\."leakvault-vscode@leakvault-local:[^"]*"\][^\n]*\n(?:(?!\n\[)[\s\S])*/g,
  ];
  for (const re of legacySections) out = out.replace(re, '');

  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function installCodexHooks(): void {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return;

  let content = '';
  try {
    content = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
  } catch {
    return;
  }

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
    // best-effort
  }
}

export function installHooks(hookScriptSource: string): { installed: boolean; message: string } {
  try {
    const destDir = path.dirname(HOOK_DEST);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(HOOK_DEST, hookScriptSource, 'utf8');
    fs.chmodSync(HOOK_DEST, 0o755);

    const settings = readSettings();
    const hooks = (settings['hooks'] as Record<string, unknown[]>) ?? {};

    const existingPrompt = (hooks['UserPromptSubmit'] as unknown[] | undefined) ?? [];
    const promptHooks: unknown[] = existingPrompt.filter((e) => !isLeakVaultEntry(e));
    promptHooks.push(claudeHookEntry());
    hooks['UserPromptSubmit'] = promptHooks;

    const existingPre = (hooks['PreToolUse'] as unknown[] | undefined) ?? [];
    const preHooks: unknown[] = existingPre.filter((e) => !isLeakVaultEntry(e));
    preHooks.push(claudeHookEntry('.*'));
    hooks['PreToolUse'] = preHooks;

    const existingPost = (hooks['PostToolUse'] as unknown[] | undefined) ?? [];
    const postHooks: unknown[] = existingPost.filter((e) => !isLeakVaultEntry(e));
    postHooks.push(claudeHookEntry('Bash'));
    postHooks.push(claudeHookEntry('execute'));
    hooks['PostToolUse'] = postHooks;

    settings['hooks'] = hooks;
    writeSettings(settings);

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
    // best-effort
  }
  uninstallCodexHooks();
}

export { SETTINGS_PATH, HOOK_DEST, CODEX_CONFIG_PATH };
