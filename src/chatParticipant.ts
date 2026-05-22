import * as vscode from 'vscode';
import { scan } from './credentialScanner';
import { VaultStorage } from './vaultStorage';
import { LeakVaultStatusBar } from './statusBar';

export function registerChatParticipant(
  ctx: vscode.ExtensionContext,
  vault: VaultStorage,
  statusBar: LeakVaultStatusBar
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'leakvault.guard',
    async (
      request: vscode.ChatRequest,
      _context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      const subCommand = request.command; // "scan" | "vault" | undefined

      // ------------------------------------------------------------------
      // /vault — list stored handles
      // ------------------------------------------------------------------
      if (subCommand === 'vault') {
        const entries = await vault.list();
        if (entries.length === 0) {
          stream.markdown('Vault is empty — no credentials have been intercepted yet.');
        } else {
          stream.markdown(`**LeakVault** — ${entries.length} stored credential(s)\n\n`);
          stream.markdown('| Handle | Stored |\n|--------|--------|\n');
          for (const e of entries) {
            stream.markdown(`| \`${e.handle}\` | ${e.storedAt.toLocaleString()} |\n`);
          }
          stream.markdown(`\n> Vault location: \`${vault.dir}\``);
        }
        return;
      }

      // ------------------------------------------------------------------
      // Default / /scan — scan the prompt, forward redacted version to LM
      // ------------------------------------------------------------------
      const cfg = vscode.workspace.getConfiguration('leakvault');
      const enabled = cfg.get<boolean>('enabled', true);

      const result = scan(request.prompt);

      if (result.count > 0) {
        // Persist each detected credential (plaintext) to the encrypted vault
        for (const h of result.handles) {
          const plaintext = result.plaintexts.get(h);
          if (plaintext) {
            await vault.store(plaintext).catch(() => undefined);
          }
        }

        statusBar.flashAlert(result.count);

        if (cfg.get<boolean>('notifyOnDetection', true)) {
          vscode.window.showWarningMessage(
            `LeakVault: ${result.count} credential(s) redacted before sending to AI.`
          );
        }

        stream.markdown(
          `> ⚠️ **LeakVault intercepted ${result.count} credential(s)** — replaced with vault handles before sending to the model.\n`
        );
        stream.markdown(`> Handles: ${result.handles.map((h) => `\`${h}\``).join(', ')}\n\n`);
        stream.markdown('---\n\n');
      }

      if (!enabled) {
        stream.markdown('> ⚠️ LeakVault protection is currently **disabled**. Enable it in settings.\n\n');
      }

      // Forward the redacted prompt to the language model
      const promptToSend = result.count > 0 ? result.redacted : request.prompt;

      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0) {
        stream.markdown('No Copilot language model available. Make sure GitHub Copilot is active.');
        return;
      }

      const messages = [vscode.LanguageModelChatMessage.User(promptToSend)];
      const response = await request.model.sendRequest(messages, {}, token);

      for await (const chunk of response.text) {
        stream.markdown(chunk);
      }
    }
  );

  participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');

  return participant;
}
