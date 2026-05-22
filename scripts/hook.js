#!/usr/bin/env node
/**
 * LeakVault standalone hook script.
 * Deployed to ~/.leakvault/hook.js by the VS Code extension and registered in:
 *   - ~/.claude/settings.json       (Claude Code)
 *   - ~/.codex/config.toml          (Codex CLI + VS Code panel)
 *
 * Behavior:
 *   - PreToolUse: deep-redact `tool_input`, allow the call to continue with
 *     credentials replaced by GPG[<handle>] markers (hookSpecificOutput.updatedInput).
 *   - UserPromptSubmit: block. Both Claude Code and Codex omit `updatedPrompt`
 *     from the UserPromptSubmit hook output schema (Codex binary confirms:
 *     `UserPromptSubmitHookSpecificOutputWire` accepts only `hookEventName` +
 *     `additionalContext` with additionalProperties: false), so blocking is
 *     the only way to keep cleartext credentials out of the model. The block
 *     reason contains the paste-ready redacted prompt.
 *   - PostToolUse: warning-only system message, non-blocking.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Credential patterns (mirrors src/credentialScanner.ts)
// ---------------------------------------------------------------------------
const PATTERNS = [
  { re: /\b((AKIA|ASIA)[A-Z0-9]{16})\b/g, cg: 1 },
  { re: /(?:aws[_-]?secret[_-]?(?:access[_-]?)?key\s*[=:]\s*)(['"]?)([A-Za-z0-9/+=]{40})\1/gi, cg: 2 },
  { re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})\b/g, cg: 1 },
  { re: /\b(sk-ant-(?:api\d+|admin01)-[A-Za-z0-9_-]{80,}(?:AA)?)\b/g, cg: 1 },
  { re: /\b(sk-(?:proj-)?[A-Za-z0-9]{20,})\b/g, cg: 1 },
  { re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g, cg: 1 },
  { re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, cg: 1 },
  { re: /\b(npm_[A-Za-z0-9]{36})\b/g, cg: 1 },
  { re: /\b(xox[baprs]-[A-Za-z0-9\-]{10,})\b/g, cg: 1 },
  { re: /\b(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]{30,})\b/g, cg: 1 },
  { re: /\b(AIza[A-Za-z0-9\-_]{35})\b/g, cg: 1 },
  { re: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:@\s]+:)([^@\s]{8,})(@)/gi, cg: 2 },
  // Tightened (no [\]\\/;:,<>?|`~) to avoid mangling regex literals — bug #2
  { re: /\b((?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[=:]\s*)(['"]?)([A-Za-z0-9!@#$%^&*()\-_+=.]{12,})\2/gi, cg: 3 },
  { re: /\b(?:my\s+)?password\s+is\s+(['"]?)([A-Za-z0-9!@#$%^&*()\-_+=.]{8,})\1/gi, cg: 2 },
];

const HANDLE_RE = /^GPG\[[a-f0-9]{12}\]$/;

function isAlreadyHandle(s) {
  return HANDLE_RE.test(s);
}

function looksLikeRegexInternal(match, fullText, startIdx) {
  if (/[A-Za-z0-9]-[A-Za-z0-9]/.test(match)) return true;
  if (/\\[bdwsnrtvfBDWS]|\\u\{|\(\?[:=!<]/.test(match)) return true;
  const before = fullText.slice(Math.max(0, startIdx - 2), startIdx);
  if (/\[\^?$/.test(before)) return true;
  return false;
}

function deriveHandle(plaintext) {
  return 'GPG[' + crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 12) + ']';
}

function shannonEntropy(s) {
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let e = 0;
  for (const k in freq) {
    const p = freq[k] / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

function charClasses(s) {
  return ((/[a-z]/.test(s)) ? 1 : 0) + ((/[A-Z]/.test(s)) ? 1 : 0) +
         ((/[0-9]/.test(s)) ? 1 : 0) + ((/[^a-zA-Z0-9]/.test(s)) ? 1 : 0);
}

function scan(text) {
  const seen = new Set();
  const handles = [];
  const plaintexts = new Map(); // handle -> plaintext
  let redacted = text;

  for (const { re, cg } of PATTERNS) {
    re.lastIndex = 0;
    redacted = redacted.replace(re, (...args) => {
      const match = args[0];
      const groups = args.slice(1, -2);
      const credential = groups[cg - 1];
      if (!credential || seen.has(credential)) return match;
      if (isAlreadyHandle(credential)) return match;
      seen.add(credential);
      const h = deriveHandle(credential);
      if (!handles.includes(h)) {
        handles.push(h);
        plaintexts.set(h, credential);
      }
      return match.replace(credential, h);
    });
  }

  // Parens are excluded from the charset on purpose: function calls like
  // `setActive(!current)` were being treated as high-entropy tokens. Real
  // credentials don't contain `(` or `)`.
  const FILE_EXT_RE = /\.(?:js|mjs|ts|tsx|jsx|py|go|rs|java|cs|cpp|rb|php|sh|md|json|yaml|yml|toml|env|xml|html|css|map|lock|vsix|whl|jar|apk|deb)$/i;
  const VERSION_RE = /[-._@]v?\d+\.\d+/;
  const STRONG_SPECIALS = /[!@#$%^&*+]/;
  const heRe = /(^|[^A-Za-z0-9])([A-Za-z0-9!@#$%^&*_+\-=]{16,64})(?=$|[^A-Za-z0-9])/g;
  heRe.lastIndex = 0;
  redacted = redacted.replace(heRe, (fullMatch, prefix, match, offset) => {
    if (seen.has(match)) return fullMatch;
    if (isAlreadyHandle(match)) return fullMatch;
    if (looksLikeRegexInternal(match, redacted, offset + prefix.length)) return fullMatch;
    const start = offset + prefix.length;
    const before = start > 0 ? redacted[start - 1] : '';
    const after = redacted[start + match.length] ?? '';
    if ((before === ':' && after === '.') || (before === '/' && after === '/')) return fullMatch;
    if (FILE_EXT_RE.test(match)) return fullMatch;
    if (VERSION_RE.test(match)) return fullMatch;
    if (!/[0-9]/.test(match) && !STRONG_SPECIALS.test(match)) return fullMatch;
    if (shannonEntropy(match) >= 3.5 && charClasses(match) >= 3) {
      seen.add(match);
      const h = deriveHandle(match);
      if (!handles.includes(h)) {
        handles.push(h);
        plaintexts.set(h, match);
      }
      return `${prefix}${h}`;
    }
    return fullMatch;
  });

  return { redacted, count: handles.length, handles, plaintexts };
}

// ---------------------------------------------------------------------------
// Encrypted vault — AES-256-GCM, key in ~/.leakvault/.key (mode 0600)
// ---------------------------------------------------------------------------
const VAULT_DIR = path.join(os.homedir(), '.leakvault');

function getOrCreateKey() {
  const keyFile = path.join(VAULT_DIR, '.key');
  try {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } catch {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

function storeCredentials(plaintexts) {
  const key = getOrCreateKey();
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  try { fs.chmodSync(VAULT_DIR, 0o700); } catch { /* best-effort */ }
  for (const [h, plaintext] of plaintexts) {
    const bareHandle = h.replace(/^GPG\[|\]$/g, '');
    const filePath = path.join(VAULT_DIR, bareHandle + '.enc');
    if (!fs.existsSync(filePath)) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      fs.writeFileSync(filePath, Buffer.concat([iv, tag, enc]), { mode: 0o600 });
    }
  }
}

// ---------------------------------------------------------------------------
// Recursively redact every string leaf in a tool_input object so we can
// pass the result back to Claude Code / Codex via hookSpecificOutput.updatedInput.
// ---------------------------------------------------------------------------
function redactDeep(value, seen, allPlaintexts) {
  if (typeof value === 'string') {
    const r = scan(value);
    for (const [h, pt] of r.plaintexts) if (!allPlaintexts.has(h)) allPlaintexts.set(h, pt);
    return r.redacted;
  }
  if (Array.isArray(value)) return value.map(v => redactDeep(v, seen, allPlaintexts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactDeep(value[k], seen, allPlaintexts);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const chunks = [];
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) chunks.push(line);
  const raw = chunks.join('\n');

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const event = input.hookEventName ?? input.hook_event_name ?? '';
  const isPromptHook = event === 'UserPromptSubmit' || typeof input.prompt === 'string';
  const isPreToolUse = event === 'PreToolUse';

  // ---- PreToolUse: deep-redact tool_input, emit updatedInput, allow ----
  if (isPreToolUse) {
    const toolInput = input.tool_input ?? input.toolInput ?? {};
    const collectedPlaintexts = new Map();
    const updatedInput = redactDeep(toolInput, new Set(), collectedPlaintexts);

    if (collectedPlaintexts.size === 0) {
      process.exit(0);
    }

    storeCredentials(collectedPlaintexts);

    const handles = [...collectedPlaintexts.keys()];
    const summary = '[LeakVault] redacted ' + collectedPlaintexts.size + ' credential(s) in tool input — handles: ' + handles.join(', ');
    process.stdout.write(JSON.stringify({
      systemMessage: summary,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: summary,
        updatedInput,
      },
    }));
    process.exit(0);
  }

  // ---- UserPromptSubmit / PostToolUse: read text from common fields ----
  let text = '';
  if (isPromptHook) {
    text = typeof input.prompt === 'string' ? input.prompt : '';
  } else {
    text = input.output ?? input.content ?? (Array.isArray(input) ? input[0]?.text : null) ?? '';
  }

  if (typeof text !== 'string' || text.length === 0) {
    process.exit(0);
  }

  const { redacted, count, handles, plaintexts } = scan(text);
  if (count === 0) {
    process.exit(0);
  }

  storeCredentials(plaintexts);

  const summary = '[LeakVault] ' + count + ' credential(s) detected — handles: ' + handles.join(', ');

  if (isPromptHook) {
    // Claude Code / Codex have no UserPromptSubmit updatedPrompt API today
    // (see anthropics/claude-code#27365). Block + suggest redacted version.
    const blockMsg = '[LeakVault] BLOCKED: Prompt contained ' + count + ' credential(s) (' + handles.join(', ') + '). Re-submit the redacted prompt instead:\n\n' + redacted;
    process.stderr.write(blockMsg);
    // Drop the redacted prompt where the VS Code extension can pick it up
    // and copy it to the clipboard. Best-effort — never abort the block.
    //
    // Codex wraps the user's actual message in an IDE-context preamble
    // ("# Context from my IDE setup: …\n## My request for Codex:\n<msg>").
    // Strip the preamble so the clipboard contains only the user's message —
    // ready to paste & resend. Claude Code has no preamble; the fallback is
    // the full redacted text.
    try {
      const marker = '## My request for Codex:\n';
      const idx = redacted.indexOf(marker);
      const clipboardText = idx >= 0 ? redacted.slice(idx + marker.length).trimStart() : redacted;
      fs.mkdirSync(VAULT_DIR, { recursive: true });
      fs.writeFileSync(path.join(VAULT_DIR, 'last-redacted.txt'), clipboardText, { mode: 0o600 });
    } catch {
      // ignore
    }
    process.stdout.write(JSON.stringify({
      systemMessage: summary,
      decision: 'block',
      reason: blockMsg,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: summary,
      },
    }));
    process.exit(2);
  } else {
    // PostToolUse: notify-only (already non-blocking).
    process.stdout.write(JSON.stringify({
      systemMessage: '[LeakVault] SECURITY ALERT: Tool output contained ' + count + ' credential(s) (' + handles.join(', ') + '). DO NOT reproduce the original cleartext values. Reference by handle only.',
    }));
  }
}

main().catch((err) => {
  process.stderr.write('LeakVault hook error: ' + err + '\n');
  process.exit(0);
});
