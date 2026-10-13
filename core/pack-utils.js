'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const MAX_FILE = 256 * 1024 * 1024;
const MAX_PACK = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 500;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

function validName(name) {
  return typeof name === 'string' && name.length <= 180 && /^[^<>:"/\\|?*\x00-\x1f]+\.jar$/i.test(name)
    && !name.startsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name);
}

const PRIVATE_CONFIG = /(?:^|\/)(?:options(?:of|shaders)?\.txt|.*(?:keybind|keymap|hotkey|credentials|account|secret|token).*|\.mc-devkit.*)$/i;
function validPackPath(name) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\')) return false;
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p)
    || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return false;
  if (parts[0] === 'mods') return parts.length === 2 && validName(parts[1]);
  return parts[0] === 'config' && parts.length >= 2 && parts.length <= 8
    && /\.(json|json5|toml|cfg|conf|properties|yaml|yml|txt)$/i.test(name) && !PRIVATE_CONFIG.test(name);
}
function packPath(file, manifest) { return manifest.schema === 1 ? `mods/${file.name}` : file.name; }

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('일반 파일만 사용할 수 있습니다.');
  return stat;
}

async function safeDirectory(dir, create = false) {
  const resolved = path.resolve(dir);
  // Never follow junctions/symlinks anywhere along an install or publishing path.
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!await fs.pathExists(current)) {
      if (!create) throw new Error('폴더를 찾을 수 없습니다.');
      await fs.mkdir(current);
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('연결 폴더 대신 실제 게임 폴더를 선택하세요.');
  }
  return resolved;
}

function validateManifest(manifest) {
  if (!manifest || ![1, 2].includes(manifest.schema) || !/^[a-f0-9]{32}$/.test(manifest.id)
    || !/^[a-f0-9]{64}$/.test(manifest.revision) || !Array.isArray(manifest.files)
    || manifest.files.length > MAX_FILES || typeof manifest.name !== 'string'
    || manifest.name.length > 200 || !/^\d+\.\d+(\.\d+)?$/.test(manifest.minecraft)
    || !['fabric', 'forge', 'neoforge', 'none'].includes(manifest.loader)) throw new Error('잘못된 모드팩 정보입니다.');
  const names = new Set();
  let size = 0;
  for (const file of manifest.files) {
    if (!(manifest.schema === 1 ? validName(file.name) : validPackPath(file.name)) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE
      || names.has(file.name.toLowerCase())) throw new Error('잘못된 모드 파일 정보입니다.');
    names.add(file.name.toLowerCase());
    size += file.size;
  }
  if (size > MAX_PACK) throw new Error('모드팩 크기가 2GB를 초과합니다.');
  if (manifest.schema === 2 && (typeof manifest.loaderVersion !== 'string' || manifest.loaderVersion.length > 80)) throw new Error('잘못된 로더 버전입니다.');
  if (revisionOf(manifest) !== manifest.revision) throw new Error('모드팩 정보의 해시가 일치하지 않습니다.');
  return manifest;
}

function revisionOf(manifest) {
  if (manifest.schema === 2) return sha256(JSON.stringify({ schema: 2, id: manifest.id,
    name: manifest.name, minecraft: manifest.minecraft, loader: manifest.loader, loaderVersion: manifest.loaderVersion, files: manifest.files }));
  return sha256(JSON.stringify({ id: manifest.id, name: manifest.name, minecraft: manifest.minecraft,
    loader: manifest.loader, files: manifest.files }));
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  await fs.ensureDir(path.dirname(file));
  try {
    await fs.writeJson(tmp, value, { spaces: 2 });
    await fs.rename(tmp, file);
  } finally { await fs.remove(tmp); }
}

module.exports = { MAX_FILE, MAX_PACK, MAX_FILES, sha256, hashFile, validName, regularFile,
  safeDirectory, validateManifest, revisionOf, writeJsonAtomic, validPackPath, packPath, PRIVATE_CONFIG };
