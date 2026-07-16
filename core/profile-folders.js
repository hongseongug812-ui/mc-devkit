'use strict';

const path = require('path');
const fs   = require('fs-extra');

function sanitizeFolder(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\uAC00-\uD7A3_-]/g, '_')
    .slice(0, 64) || 'default';
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function profileDirectory(serverDir, serverFolder) {
  if (typeof serverFolder !== 'string' || !serverFolder || /[\\/]/.test(serverFolder) || serverFolder === '.' || serverFolder === '..') {
    throw new Error('Invalid profile server folder');
  }

  const root = path.resolve(serverDir);
  const target = path.resolve(root, serverFolder);
  const relative = path.relative(root, target);

  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Invalid profile server folder');
  }
  return target;
}

function profilePathKey(name, profile, fallbackServerDir) {
  const serverDir = profile.serverDir || fallbackServerDir;
  const folder = profile.serverFolder || sanitizeFolder(name);
  return pathKey(profileDirectory(serverDir, folder));
}

async function allocateProfileFolder(name, serverDir, profiles) {
  const base = sanitizeFolder(name);
  const targetRoot = pathKey(serverDir);
  const used = new Set();

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!profile || pathKey(profile.serverDir || serverDir) !== targetRoot) continue;
    try {
      used.add(profilePathKey(profileName, profile, serverDir));
    } catch {}
  }

  for (let index = 1; index < 10000; index += 1) {
    const suffix = index === 1 ? '' : `-${index}`;
    const folder = base.slice(0, 64 - suffix.length) + suffix;
    const dir = profileDirectory(serverDir, folder);
    if (!used.has(pathKey(dir)) && !await fs.pathExists(dir)) return folder;
  }

  throw new Error('Unable to allocate a unique profile server folder');
}

module.exports = {
  allocateProfileFolder,
  pathKey,
  profileDirectory,
  profilePathKey,
  sanitizeFolder,
};
