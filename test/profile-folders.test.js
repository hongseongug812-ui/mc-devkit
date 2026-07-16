'use strict';

const assert = require('node:assert/strict');
const fs     = require('fs-extra');
const os     = require('node:os');
const path   = require('node:path');
const test   = require('node:test');

const {
  allocateProfileFolder,
  profileDirectory,
  sanitizeFolder,
} = require('../core/profile-folders');

test('sanitizeFolder creates stable filesystem-safe names', () => {
  assert.equal(sanitizeFolder(' My Server! '), 'my_server_');
  assert.equal(sanitizeFolder('한글 서버'), '한글_서버');
  assert.equal(sanitizeFolder(''), 'default');
});

test('allocateProfileFolder avoids profile-name collisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-devkit-profile-'));
  try {
    const profiles = {
      'My Server': { serverDir: root, serverFolder: 'my_server' },
    };
    assert.equal(await allocateProfileFolder('my_server', root, profiles), 'my_server-2');
  } finally {
    await fs.remove(root);
  }
});

test('allocateProfileFolder never reuses an orphaned server directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-devkit-profile-'));
  try {
    await fs.ensureDir(path.join(root, 'survival'));
    await fs.ensureDir(path.join(root, 'survival', 'world'));
    await fs.ensureDir(path.join(root, 'survival', 'plugins'));
    assert.equal(await allocateProfileFolder('Survival', root, {}), 'survival-2');
  } finally {
    await fs.remove(root);
  }
});

test('profileDirectory rejects paths outside the server root', () => {
  const root = path.resolve('server-root');
  assert.throws(() => profileDirectory(root, '..'), /Invalid profile server folder/);
  assert.throws(() => profileDirectory(root, '../other'), /Invalid profile server folder/);
  assert.throws(() => profileDirectory(root, '..\\other'), /Invalid profile server folder/);
  assert.equal(profileDirectory(root, 'profile-a'), path.join(root, 'profile-a'));
});
