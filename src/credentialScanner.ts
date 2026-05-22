import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

export interface ScanResult {
  original: string;
  redacted: string;
  count: number;
  handles: string[];
  /** Maps each GPG[...] handle to the original plaintext credential */
  plaintexts: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// Each entry describes what to match and which capture group IS the credential
// (credGroup = 0 means the whole match is the credential).
// ---------------------------------------------------------------------------
interface PatternDef {
  name: string;
  re: RegExp;
  credGroup: number;
}

const PATTERNS: PatternDef[] = [
  { name: 'aws_key_id', re: /\b((AKIA|ASIA)[A-Z0-9]{16})\b/g, credGroup: 1 },
  { name: 'aws_secret', re: /(?:aws[_-]?secret[_-]?(?:access[_-]?)?key\s*[=:]\s*)(['"]?)([A-Za-z0-9/+=]{40})\1/gi, credGroup: 2 },
  { name: 'github_pat', re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})\b/g, credGroup: 1 },
  { name: 'anthropic', re: /\b(sk-ant-(?:api\d+|admin01)-[A-Za-z0-9_-]{80,}(?:AA)?)\b/g, credGroup: 1 },
  { name: 'openai', re: /\b(sk-(?:proj-)?[A-Za-z0-9]{20,})\b/g, credGroup: 1 },
  { name: 'stripe', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g, credGroup: 1 },
  { name: 'jwt', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, credGroup: 1 },
  { name: 'npm_token', re: /\b(npm_[A-Za-z0-9]{36})\b/g, credGroup: 1 },
  { name: 'slack', re: /\b(xox[baprs]-[A-Za-z0-9\-]{10,})\b/g, credGroup: 1 },
  { name: 'slack_hook', re: /\b(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]{30,})\b/g, credGroup: 1 },
  { name: 'google_api', re: /\b(AIza[A-Za-z0-9\-_]{35})\b/g, credGroup: 1 },
  { name: 'db_url', re: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:@\s]+:)([^@\s]{8,})(@)/gi, credGroup: 2 },
  // Generic "key = value" — value charset tightened (see AGENT_NOTES bug #2)
  { name: 'generic_kv', re: /\b((?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[=:]\s*)(['"]?)([A-Za-z0-9!@#$%^&*()\-_+=.]{12,})\2/gi, credGroup: 3 },
  { name: 'natural_lang', re: /\b(?:my\s+)?password\s+is\s+(['"]?)([A-Za-z0-9!@#$%^&*()\-_+=.]{8,})\1/gi, credGroup: 2 },
];

export function deriveHandle(plaintext: string): string {
  return 'GPG[' + crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 12) + ']';
}

// Self-redaction guards (Bug #2 / #3)
const HANDLE_RE = /^GPG\[[a-f0-9]{12}\]$/;

function isAlreadyHandle(s: string): boolean {
  return HANDLE_RE.test(s);
}

function looksLikeRegexInternal(match: string, fullText: string, startIdx: number): boolean {
  if (/[A-Za-z0-9]-[A-Za-z0-9]/.test(match)) return true;
  if (/\\[bdwsnrtvfBDWS]|\\u\{|\(\?[:=!<]/.test(match)) return true;
  const before = fullText.slice(Math.max(0, startIdx - 2), startIdx);
  if (/\[\^?$/.test(before)) return true;
  return false;
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function charClasses(s: string): number {
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[^a-zA-Z0-9]/.test(s)) classes++;
  return classes;
}

// Parens are excluded from the charset on purpose: function calls like
// `setActive(!current)` were being treated as high-entropy tokens. Real
// credentials don't contain `(` or `)`.
const HIGH_ENTROPY_RE = /(^|[^A-Za-z0-9])([A-Za-z0-9!@#$%^&*_+\-=]{16,64})(?=$|[^A-Za-z0-9])/g;
const FILE_EXT_RE = /\.(?:js|mjs|ts|tsx|jsx|py|go|rs|java|cs|cpp|rb|php|sh|md|json|yaml|yml|toml|env|xml|html|css|map|lock|vsix|whl|jar|apk|deb)$/i;
const VERSION_RE = /[-._@]v?\d+\.\d+/;
const STRONG_SPECIALS = /[!@#$%^&*+]/;

function redactHighEntropy(
  text: string,
  seen: Set<string>,
): { text: string; handles: string[]; plaintexts: Map<string, string> } {
  const handles: string[] = [];
  const plaintexts = new Map<string, string>();
  const result = text.replace(HIGH_ENTROPY_RE, (fullMatch, prefix: string, match: string, offset: number) => {
    if (seen.has(match)) return fullMatch;
    if (isAlreadyHandle(match)) return fullMatch;
    if (looksLikeRegexInternal(match, text, offset + prefix.length)) return fullMatch;
    if (FILE_EXT_RE.test(match)) return fullMatch;
    if (VERSION_RE.test(match)) return fullMatch;
    const start = offset + prefix.length;
    const before = start > 0 ? text[start - 1] : '';
    const after = text[start + match.length] ?? '';
    if ((before === ':' && after === '.') || (before === '/' && after === '/')) return fullMatch;
    if (!/[0-9]/.test(match) && !STRONG_SPECIALS.test(match)) return fullMatch;
    if (shannonEntropy(match) >= 3.5 && charClasses(match) >= 3) {
      seen.add(match);
      const h = deriveHandle(match);
      handles.push(h);
      plaintexts.set(h, match);
      return `${prefix}${h}`;
    }
    return fullMatch;
  });
  return { text: result, handles, plaintexts };
}

export function scan(text: string): ScanResult {
  const seen = new Set<string>();
  const handles: string[] = [];
  const plaintexts = new Map<string, string>();
  let redacted = text;

  for (const { re, credGroup } of PATTERNS) {
    re.lastIndex = 0;
    redacted = redacted.replace(re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const credential = groups[credGroup - 1];
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

  const { text: finalText, handles: entropyHandles, plaintexts: entropyPlaintexts } = redactHighEntropy(redacted, seen);
  redacted = finalText;
  for (const h of entropyHandles) {
    if (!handles.includes(h)) {
      handles.push(h);
      const pt = entropyPlaintexts.get(h);
      if (pt) plaintexts.set(h, pt);
    }
  }

  return { original: text, redacted, count: handles.length, handles, plaintexts };
}

export function defaultVaultDir(): string {
  return path.join(os.homedir(), '.leakvault');
}
