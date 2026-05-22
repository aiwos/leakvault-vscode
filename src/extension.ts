import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { scan } from './credentialScanner';
import { registerChatParticipant } from './chatParticipant';
import { installHooks, uninstallHooks } from './hookManager';
import { LeakVaultStatusBar } from './statusBar';
import { VaultStorage } from './vaultStorage';

let statusBar: LeakVaultStatusBar | undefined;
let vault: VaultStorage | undefined;

const REDACTED_FILE = path.join(os.homedir(), '.leakvault', 'last-redacted.txt');

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  vault = new VaultStorage(ctx.secrets);
  await vault.init();

  statusBar = new LeakVaultStatusBar();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  const cfg = vscode.workspace.getConfiguration('leakvault');

  if (cfg.get<boolean>('autoInstallHooks', true)) {
    doInstallHooks(ctx);
  }

  // Watch ~/.leakvault/last-redacted.txt. The hook writes the redacted prompt
  // there whenever it blocks a UserPromptSubmit; copying it straight to the
  // clipboard turns the block UX into "Ctrl+A → paste → Enter".
  setupRedactedClipboardWatcher(ctx);

  const participant = registerChatParticipant(ctx, vault, statusBar);
  ctx.subscriptions.push(participant);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('leakvault.installHooks', () => {
      const result = doInstallHooks(ctx);
      vscode.window.showInformationMessage(result.message);
    }),

    vscode.commands.registerCommand('leakvault.toggleProtection', () => {
      const current = cfg.get<boolean>('enabled', true);
      vscode.workspace
        .getConfiguration('leakvault')
        .update('enabled', !current, vscode.ConfigurationTarget.Global);
      statusBar?.setActive(!current);
      vscode.window.showInformationMessage(
        `LeakVault protection ${!current ? 'enabled' : 'disabled'}.`
      );
    }),

    vscode.commands.registerCommand('leakvault.openVault', async () => {
      if (!vault) return;
      const entries = await vault.list();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('LeakVault: vault is empty.');
        return;
      }
      const items = entries.map((e) => ({
        label: e.handle,
        description: `stored ${e.storedAt.toLocaleString()}`,
      }));
      vscode.window.showQuickPick(items, {
        title: `LeakVault — ${entries.length} credential(s) stored`,
        placeHolder: 'Handles stored in vault (AES-256-GCM encrypted)',
      });
    }),

    vscode.commands.registerCommand('leakvault.scanClipboard', async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text) {
        vscode.window.showInformationMessage('Clipboard is empty.');
        return;
      }
      const result = scan(text);
      if (result.count === 0) {
        vscode.window.showInformationMessage('LeakVault: no credentials found in clipboard.');
        return;
      }
      await vscode.env.clipboard.writeText(result.redacted);
      statusBar?.flashAlert(result.count);
      vscode.window.showWarningMessage(
        `LeakVault: ${result.count} credential(s) redacted from clipboard.`
      );
    }),

    vscode.commands.registerCommand('leakvault.scanSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('No text selected.');
        return;
      }
      const selected = editor.document.getText(editor.selection);
      const result = scan(selected);
      if (result.count === 0) {
        vscode.window.showInformationMessage('LeakVault: no credentials found in selection.');
        return;
      }
      await editor.edit((eb) => eb.replace(editor.selection, result.redacted));
      statusBar?.flashAlert(result.count);
      vscode.window.showWarningMessage(
        `LeakVault: ${result.count} credential(s) redacted.`
      );
    })
  );
}

export function deactivate(): void {
  uninstallHooks();
}

function doInstallHooks(ctx: vscode.ExtensionContext): { message: string } {
  const hookScriptPath = path.join(ctx.extensionPath, 'scripts', 'hook.js');
  let hookScript: string;
  try {
    hookScript = fs.readFileSync(hookScriptPath, 'utf8');
  } catch {
    return { message: 'LeakVault: could not read bundled hook script.' };
  }
  return installHooks(hookScript);
}

function setupRedactedClipboardWatcher(ctx: vscode.ExtensionContext): void {
  fs.mkdirSync(path.dirname(REDACTED_FILE), { recursive: true });

  // Track mtime so we only react when the file is actually rewritten.
  let lastMtimeMs = 0;
  try {
    lastMtimeMs = fs.statSync(REDACTED_FILE).mtimeMs;
  } catch {
    // file may not exist yet
  }

  const onChange = async (): Promise<void> => {
    try {
      const stat = fs.statSync(REDACTED_FILE);
      if (stat.mtimeMs === lastMtimeMs) return;
      lastMtimeMs = stat.mtimeMs;

      const redacted = fs.readFileSync(REDACTED_FILE, 'utf8');
      if (!redacted) return;

      await vscode.env.clipboard.writeText(redacted);
      statusBar?.flashAlert(1);

      const cfg = vscode.workspace.getConfiguration('leakvault');
      if (cfg.get<boolean>('notifyOnDetection', true)) {
        vscode.window.showWarningMessage('LeakVault: redacted prompt in clipboard — Ctrl+V.');
      }
    } catch {
      // best-effort
    }
  };

  // VS Code's FileSystemWatcher doesn't watch outside the workspace, so use
  // fs.watch on the parent directory and filter by filename.
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(path.dirname(REDACTED_FILE), (_event, filename) => {
      if (filename === 'last-redacted.txt') {
        void onChange();
      }
    });
  } catch {
    // best-effort
  }

  ctx.subscriptions.push({ dispose: () => watcher?.close() });
}
