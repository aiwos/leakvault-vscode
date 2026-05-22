import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { scan } from './credentialScanner';
import { registerChatParticipant } from './chatParticipant';
import { installHooks, uninstallHooks } from './hookManager';
import { LeakVaultStatusBar } from './statusBar';
import { VaultStorage } from './vaultStorage';

let statusBar: LeakVaultStatusBar | undefined;
let vault: VaultStorage | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  vault = new VaultStorage(ctx.secrets);
  await vault.init();

  statusBar = new LeakVaultStatusBar();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  const cfg = vscode.workspace.getConfiguration('leakvault');

  if (cfg.get<boolean>('autoInstallHooks', true)) {
    doInstallHooks(ctx);
  }

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
        `LeakVault: ${result.count} credential(s) redacted from clipboard. Handles: ${result.handles.join(', ')}`
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
        `LeakVault: ${result.count} credential(s) redacted. Handles: ${result.handles.join(', ')}`
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
