import * as vscode from 'vscode';

export class LeakVaultStatusBar {
  private readonly item: vscode.StatusBarItem;
  private count = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'leakvault.openVault';
    this.item.tooltip = 'LeakVault — click to open vault';
    this.setActive(true);
    this.item.show();
  }

  setActive(enabled: boolean): void {
    if (enabled) {
      this.item.text = `$(lock) LeakVault`;
      this.item.backgroundColor = undefined;
      this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
    } else {
      this.item.text = `$(unlock) LeakVault (off)`;
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    }
  }

  flashAlert(newCredentialCount: number): void {
    this.count += newCredentialCount;
    this.item.text = `$(warning) LeakVault — ${this.count} redacted`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    setTimeout(() => {
      const cfg = vscode.workspace.getConfiguration('leakvault');
      this.setActive(cfg.get<boolean>('enabled', true));
      if (this.count > 0) {
        this.item.text = `$(lock) LeakVault (${this.count})`;
      }
    }, 3000);
  }

  resetCount(): void {
    this.count = 0;
    const cfg = vscode.workspace.getConfiguration('leakvault');
    this.setActive(cfg.get<boolean>('enabled', true));
  }

  dispose(): void {
    this.item.dispose();
  }
}
