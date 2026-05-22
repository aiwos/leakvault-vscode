#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scan } = require('../out/credentialScanner');

const repeated = (char, length) => char.repeat(length);

const cases = [
  {
    name: 'AWS access key id',
    input: `aws_access_key_id = AKIA${repeated('A', 16)}`,
    secret: `AKIA${repeated('A', 16)}`,
  },
  {
    name: 'AWS secret access key',
    input: `aws_secret_access_key = ${repeated('a', 40)}`,
    secret: repeated('a', 40),
  },
  {
    name: 'GitHub token',
    input: `github_token = ghp_${repeated('A', 36)}`,
    secret: `ghp_${repeated('A', 36)}`,
  },
  {
    name: 'OpenAI key',
    input: `openai_key = sk-proj-${repeated('A', 40)}`,
    secret: `sk-proj-${repeated('A', 40)}`,
  },
  {
    name: 'Anthropic key',
    input: `anthropic_key = sk-ant-api03-${repeated('A', 80)}`,
    secret: `sk-ant-api03-${repeated('A', 80)}`,
  },
  {
    name: 'Stripe key',
    input: `stripe_key = sk_test_${repeated('A', 20)}`,
    secret: `sk_test_${repeated('A', 20)}`,
  },
  {
    name: 'JWT',
    input: `jwt = eyJ${repeated('A', 11)}.${repeated('B', 11)}.${repeated('C', 11)}`,
    secret: `eyJ${repeated('A', 11)}.${repeated('B', 11)}.${repeated('C', 11)}`,
  },
  {
    name: 'npm token',
    input: `npm_token = npm_${repeated('A', 36)}`,
    secret: `npm_${repeated('A', 36)}`,
  },
  {
    name: 'Slack token',
    input: `slack_token = xoxb-${repeated('A', 10)}`,
    secret: `xoxb-${repeated('A', 10)}`,
  },
  {
    name: 'Slack webhook URL',
    input: `webhook = https://hooks.slack.com/services/T00000000/B00000000/${repeated('X', 24)}`,
    secret: `https://hooks.slack.com/services/T00000000/B00000000/${repeated('X', 24)}`,
  },
  {
    name: 'Google API key',
    input: `google_api_key = AIza${repeated('A', 35)}`,
    secret: `AIza${repeated('A', 35)}`,
  },
  {
    name: 'Postgres URL password segment',
    input: 'DATABASE_URL=postgres://admin:S3cr3t_DB_Pass_123@db.example.com/app',
    secret: 'S3cr3t_DB_Pass_123',
    mustContain: ['postgres://admin:', '@db.example.com/app'],
  },
  {
    name: 'Generic password assignment',
    input: 'password = Sup3r$ecretValue2026!',
    secret: 'Sup3r$ecretValue2026!',
  },
  {
    name: 'Generic private key assignment',
    input: 'private_key = AbCdEf1234567890!',
    secret: 'AbCdEf1234567890!',
  },
  {
    name: 'Natural language password',
    input: 'my password is Tr0ub4dor3!',
    secret: 'Tr0ub4dor3!',
  },
  {
    name: 'High entropy standalone token',
    input: 'custom token A9m$Q2z@L8p#T5r6 should be hidden',
    secret: 'A9m$Q2z@L8p#T5r6',
  },
  {
    name: 'Bare password-like token with trailing punctuation',
    input: 'Mypasssword12345!!!',
    secret: 'Mypasssword12345!!!',
    redactedPattern: /^GPG\[[0-9a-f]{12}\]$/,
  },
];

const hasHandle = (text) => /GPG\[[0-9a-f]{12}\]/.test(text);

function validateRedaction(result, testCase) {
  const errors = [];

  if (result.count < 1) {
    errors.push('reported zero credentials');
  }
  if (!hasHandle(result.redacted)) {
    errors.push('redacted output has no GPG handle');
  }
  if (result.redacted.includes(testCase.secret)) {
    errors.push('redacted output still contains the secret');
  }
  if (testCase.redactedPattern && !testCase.redactedPattern.test(result.redacted)) {
    errors.push(`redacted output did not match ${testCase.redactedPattern}`);
  }
  for (const expected of testCase.mustContain ?? []) {
    if (!result.redacted.includes(expected)) {
      errors.push(`redacted output removed non-secret context: ${expected}`);
    }
  }

  return errors;
}

function runScannerSuite() {
  return cases.map((testCase) => {
    const result = scan(testCase.input);
    return {
      suite: 'scanner',
      name: testCase.name,
      passed: validateRedaction(result, testCase).length === 0,
      errors: validateRedaction(result, testCase),
      redacted: result.redacted,
      handles: result.handles,
    };
  });
}

function runHookSuite() {
  return cases.map((testCase) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leakvault-e2e-home-'));
    const input = JSON.stringify({
      hookEventName: 'UserPromptSubmit',
      prompt: testCase.input,
    });

    const hook = spawnSync(process.execPath, [path.join(__dirname, 'hook.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home },
      input,
      encoding: 'utf8',
    });

    const errors = [];
    let redacted = '';
    let handles = [];

    if (hook.error) {
      errors.push(hook.error.message);
    }
    if (hook.stderr.trim()) {
      errors.push(`stderr: ${hook.stderr.trim()}`);
    }
    if (!hook.stdout.trim()) {
      errors.push('hook produced no redaction output');
    } else {
      try {
        const output = JSON.parse(hook.stdout);
        if (output.decision !== 'block') {
          errors.push('hook did not block a credential-bearing prompt');
        }

        const reason = output.reason ?? '';
        if (reason.includes(testCase.secret)) {
          errors.push('hook block reason still contains the secret');
        }

        redacted = reason.split('Re-submit the redacted prompt instead:\n\n')[1] ?? '';
        handles = [...reason.matchAll(/GPG\[[0-9a-f]{12}\]/g)].map((match) => match[0]);
        errors.push(...validateRedaction({ count: handles.length, redacted }, testCase));
      } catch (error) {
        errors.push(`hook output was not JSON: ${error.message}`);
      }
    }

    const vaultDir = path.join(home, '.leakvault');
    if (fs.existsSync(vaultDir)) {
      for (const file of fs.readdirSync(vaultDir)) {
        const contents = fs.readFileSync(path.join(vaultDir, file));
        if (contents.includes(Buffer.from(testCase.secret, 'utf8'))) {
          errors.push(`vault file ${file} contains plaintext secret`);
        }
      }
    }

    fs.rmSync(home, { recursive: true, force: true });

    return {
      suite: 'hook',
      name: testCase.name,
      passed: errors.length === 0,
      errors,
      redacted,
      handles,
    };
  });
}

const results = [...runScannerSuite(), ...runHookSuite()];
const failed = results.filter((result) => !result.passed);

for (const result of results) {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`${status} ${result.suite}: ${result.name}`);
  for (const error of result.errors) {
    console.log(`  - ${error}`);
  }
}

console.log('');
console.log(`Summary: ${results.length - failed.length}/${results.length} checks passed`);

if (failed.length > 0) {
  process.exitCode = 1;
}
