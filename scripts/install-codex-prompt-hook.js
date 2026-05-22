#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const hookDest = path.join(home, '.leakvault', 'hook.js');
const marketplaceRoot = path.join(home, '.leakvault', 'codex-plugins');
const pluginDir = path.join(marketplaceRoot, 'plugins', 'leakvault-vscode');
const marketplaceId = 'leakvault-local';
const pluginId = `leakvault-vscode@${marketplaceId}`;
const codexConfig = path.join(home, '.codex', 'config.toml');

const hooksJson = {
  hooks: {
    UserPromptSubmit: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `node "${hookDest}"` }],
        description:
          'LeakVault credential guard - redacts secrets from user prompts before they reach the model.',
      },
    ],
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `node "${hookDest}"` }],
        description:
          'LeakVault credential guard - redacts secrets in tool inputs before they reach the model.',
      },
    ],
    PostToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node "${hookDest}"` }],
        description:
          'LeakVault credential guard - redacts secrets in Bash tool outputs.',
      },
    ],
  },
};

const pluginJson = {
  name: 'leakvault-vscode',
  version: '1.0.0',
  description: 'LeakVault credential guard hooks for Codex.',
  author: {
    name: 'LeakVault',
  },
  license: 'MIT',
  keywords: ['security', 'secrets', 'redaction', 'hooks'],
  hooks: './hooks.json',
  interface: {
    displayName: 'LeakVault',
    shortDescription: 'Redacts secrets before Codex sees them',
    longDescription:
      'Runs local Codex hooks that redact credentials from user prompts, tool inputs, and selected tool outputs. Cleartext credentials are encrypted locally and replaced with GPG[handle] markers.',
    developerName: 'LeakVault',
    category: 'Security',
    capabilities: ['Read', 'Write'],
    defaultPrompt: ['Use LeakVault secret redaction.'],
  },
};

const marketplaceJson = {
  name: marketplaceId,
  interface: {
    displayName: 'LeakVault Local',
  },
  plugins: [
    {
      name: 'leakvault-vscode',
      source: {
        source: 'local',
        path: './plugins/leakvault-vscode',
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Security',
    },
  ],
};

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendTomlSection(configPath, section, body) {
  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Missing config is fine; create it below.
  }

  if (content.includes(`[${section}]`) || content.includes(`["${section}"]`)) {
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${content}\n[${section}]\n${body}\n`, 'utf8');
}

const bundledHook = path.join(__dirname, 'hook.js');
fs.mkdirSync(path.dirname(hookDest), { recursive: true });
fs.copyFileSync(bundledHook, hookDest);

writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), marketplaceJson);
writeJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'), pluginJson);
writeJson(path.join(pluginDir, 'hooks.json'), hooksJson);

appendTomlSection(
  codexConfig,
  `marketplaces.${marketplaceId}`,
  `source_type = "local"\nsource = "${marketplaceRoot}"`,
);
appendTomlSection(codexConfig, `plugins."${pluginId}"`, 'enabled = true');

console.log(`Installed ${pluginId}`);
console.log(`Marketplace: ${marketplaceRoot}`);
console.log(`Hook script: ${hookDest}`);
