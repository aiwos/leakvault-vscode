import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { defaultVaultDir, deriveHandle } from './credentialScanner';

const KEY_SECRET_ID = 'leakvault.aes256.key.v1';

export interface VaultEntry {
  handle: string;
  storedAt: Date;
}

export class VaultStorage {
  private key: Buffer | null = null;
  private readonly vaultDir: string;

  constructor(private readonly secrets: vscode.SecretStorage) {
    const cfg = vscode.workspace.getConfiguration('leakvault');
    const customDir = cfg.get<string>('vaultDir', '');
    this.vaultDir = customDir?.trim() ? customDir.trim() : defaultVaultDir();
  }

  // -------------------------------------------------------------------------
  // Initialise: load or generate AES-256 key via VS Code SecretStorage
  // -------------------------------------------------------------------------
  async init(): Promise<void> {
    let keyHex = await this.secrets.get(KEY_SECRET_ID);
    if (!keyHex) {
      keyHex = crypto.randomBytes(32).toString('hex');
      await this.secrets.store(KEY_SECRET_ID, keyHex);
    }
    this.key = Buffer.from(keyHex, 'hex');
    await fs.promises.mkdir(this.vaultDir, { recursive: true });
    // Ensure vault directory permissions are owner-only (0700)
    await fs.promises.chmod(this.vaultDir, 0o700);
  }

  // -------------------------------------------------------------------------
  // Encrypt one credential value and write to disk
  // -------------------------------------------------------------------------
  async store(plaintext: string): Promise<string> {
    if (!this.key) throw new Error('VaultStorage not initialised');

    const handle = deriveHandle(plaintext).replace(/^GPG\[|\]$/g, ''); // bare hex handle
    const filePath = path.join(this.vaultDir, `${handle}.enc`);

    // Avoid re-encrypting the same value
    if (fs.existsSync(filePath)) return `GPG[${handle}]`;

    // AES-256-GCM: 12-byte random IV | 16-byte auth tag | ciphertext
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, encrypted]);

    await fs.promises.writeFile(filePath, payload);
    // Ensure vault files are owner-only readable (0600)
    await fs.promises.chmod(filePath, 0o600);
    return `GPG[${handle}]`;
  }

  // -------------------------------------------------------------------------
  // Decrypt a stored credential by its bare handle (no GPG[...] wrapper)
  // -------------------------------------------------------------------------
  async retrieve(bareHandle: string): Promise<string> {
    if (!this.key) throw new Error('VaultStorage not initialised');

    const filePath = path.join(this.vaultDir, `${bareHandle}.enc`);
    const payload = await fs.promises.readFile(filePath);

    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  // -------------------------------------------------------------------------
  // List all stored handles
  // -------------------------------------------------------------------------
  async list(): Promise<VaultEntry[]> {
    try {
      const files = await fs.promises.readdir(this.vaultDir);
      return files
        .filter((f) => f.endsWith('.enc'))
        .map((f) => ({
          handle: `GPG[${f.replace('.enc', '')}]`,
          storedAt: fs.statSync(path.join(this.vaultDir, f)).mtime,
        }))
        .sort((a, b) => b.storedAt.getTime() - a.storedAt.getTime());
    } catch {
      return [];
    }
  }

  get dir(): string {
    return this.vaultDir;
  }
}
