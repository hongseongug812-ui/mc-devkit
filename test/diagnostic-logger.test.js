'use strict';

const assert = require('node:assert/strict');
const fs     = require('fs-extra');
const os     = require('node:os');
const path   = require('node:path');
const test   = require('node:test');

const { DiagnosticLogger, redactText } = require('../core/diagnostic-logger');

test('redactText removes credentials and claim tokens', () => {
  const value = redactText('token=abc password:xyz --secret_key raw https://playit.gg/claim/private');
  assert.doesNotMatch(value, /abc|xyz|\sraw|\/private/);
  assert.match(value, /\[REDACTED\]/);
});

test('DiagnosticLogger persists ordered records and redacts structured secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-devkit-log-'));
  const fixed = new Date('2026-07-16T13:00:00.000Z');
  try {
    const logger = new DiagnosticLogger({ logDir: root, now: () => fixed });
    logger.info('api', 'profile created', { name: 'survival', ownerToken: 'private-token' });
    logger.error('minecraft.stderr', new Error('boom password=hunter2'));
    logger.flushSync();

    const file = logger.latestFile();
    const content = await fs.readFile(file, 'utf8');
    assert.match(content, /\[INFO\] \[api\] profile created/);
    assert.match(content, /\[ERROR\] \[minecraft\.stderr\]/);
    assert.match(content, /"ownerToken":"\[REDACTED\]"/);
    assert.doesNotMatch(content, /private-token|hunter2/);
  } finally {
    await fs.remove(root);
  }
});
