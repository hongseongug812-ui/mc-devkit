'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { gameRunning } = require('./game-process');
const { MAX_FILE, MAX_PACK, hashFile, validName, regularFile, safeDirectory,
  validateManifest, writeJsonAtomic } = require('./pack-utils');

const STATE = '.mc-devkit-sync.json';
const JOURNAL = '.mc-devkit-transaction.json';

function parseInvite(invite) {
  const url = new URL(invite);
  const id = url.searchParams.get('join');
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || !/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('호스트가 복사한 모드팩 참가 링크를 입력하세요.');
  return { id, token, origin: url.origin };
}

async function readState(modsDir) {
  const file = path.join(modsDir, STATE);
  if (!await fs.pathExists(file)) return null;
  await regularFile(file);
  return validateManifest(await fs.readJson(file));
}

async function rollback(modsDir, journal) {
  if (!/^[a-f0-9]{32}$/.test(journal.backup) || !Array.isArray(journal.files) || journal.files.length > 1000
    || journal.files.some(f => !validName(f.name) || typeof f.existed !== 'boolean')) throw new Error('복구 기록을 확인할 수 없습니다. 백업 폴더를 확인하세요.');
  const backupDir = await safeDirectory(path.join(modsDir, '.mc-devkit-backups', journal.backup));
  for (const file of journal.files) {
    const dest = path.join(modsDir, file.name);
    if (await fs.pathExists(dest)) await regularFile(dest);
    if (file.existed) {
      const source = path.join(backupDir, file.name);
      await regularFile(source);
      await fs.copyFile(source, dest);
    } else await fs.remove(dest);
  }
  if (journal.before) await writeJsonAtomic(path.join(modsDir, STATE), validateManifest(journal.before));
  else await fs.remove(path.join(modsDir, STATE));
  await fs.remove(path.join(modsDir, JOURNAL));
}

async function installManifest(modsDir, manifest, download, isRunning = gameRunning) {
  validateManifest(manifest);
  modsDir = await safeDirectory(modsDir, true);
  if (await isRunning()) return { status: 'waiting', message: 'Minecraft를 종료하면 자동으로 적용됩니다.' };
  if (await fs.pathExists(path.join(modsDir, JOURNAL))) {
    await regularFile(path.join(modsDir, JOURNAL));
    await rollback(modsDir, await fs.readJson(path.join(modsDir, JOURNAL)));
  }
  const before = await readState(modsDir);
  if (before && before.id !== manifest.id) throw new Error('다른 서버의 모드팩이 연결된 게임 폴더입니다. 별도 게임 인스턴스를 선택하세요.');
  const oldFiles = new Map((before?.files || []).map(f => [f.name.toLowerCase(), f]));
  const newFiles = new Map(manifest.files.map(f => [f.name.toLowerCase(), f]));
  const changed = [];
  const removed = [];
  const existingNames = new Map((await fs.readdir(modsDir)).map(n => [n.toLowerCase(), n]));
  for (const file of manifest.files) {
    const actualName = existingNames.get(file.name.toLowerCase());
    if (actualName && actualName !== file.name) throw new Error(`대소문자가 다른 파일이 있습니다: ${actualName}. 파일명을 정리하세요.`);
    const dest = path.join(modsDir, file.name);
    if (actualName) {
      await regularFile(dest);
      const hash = await hashFile(dest);
      // An existing unmanaged mod is never adopted or overwritten implicitly.
      if (!oldFiles.has(file.name.toLowerCase())) throw new Error(`기존 개인 모드와 이름이 겹칩니다: ${file.name}. 새 게임 인스턴스를 사용하거나 해당 파일을 옮겨주세요.`);
      if (hash !== oldFiles.get(file.name.toLowerCase()).sha256) throw new Error(`직접 수정된 모드를 보호하기 위해 중지했습니다: ${file.name}. 파일을 다른 곳에 옮기고 다시 동기화하세요.`);
      if (hash === file.sha256) continue;
    }
    changed.push(file);
  }
  for (const file of before?.files || []) {
    if (newFiles.has(file.name.toLowerCase())) continue;
    const dest = path.join(modsDir, file.name);
    if (await fs.pathExists(dest)) {
      await regularFile(dest);
      if (await hashFile(dest) !== file.sha256) throw new Error(`직접 수정된 모드를 보호하기 위해 중지했습니다: ${file.name}`);
      removed.push(file);
    }
  }
  if (!changed.length && !removed.length && before?.revision === manifest.revision) {
    return { status: 'current', message: '최신 모드팩입니다.', revision: manifest.revision };
  }
  const stage = path.join(modsDir, `.mc-devkit-stage-${crypto.randomBytes(16).toString('hex')}`);
  await fs.mkdir(stage);
  try {
    let total = 0;
    for (const file of changed) {
      const data = await download(file);
      total += data.length;
      if (data.length !== file.size || data.length > MAX_FILE || total > MAX_PACK) throw new Error(`다운로드 크기가 일치하지 않습니다: ${file.name}`);
      const target = path.join(stage, file.name);
      await fs.writeFile(target, data);
      if (await hashFile(target) !== file.sha256) throw new Error(`다운로드 검증 실패: ${file.name}`);
    }
    if (await isRunning()) return { status: 'waiting', message: '게임이 실행되어 적용을 보류했습니다. 종료 후 다시 확인합니다.' };
    // Re-check managed files after downloading; users may have edited them while it ran.
    for (const file of [...changed, ...removed]) {
      const dest = path.join(modsDir, file.name);
      const old = oldFiles.get(file.name.toLowerCase());
      if (await fs.pathExists(dest)) {
        await regularFile(dest);
        if (!old || await hashFile(dest) !== old.sha256) throw new Error(`다운로드 중 파일이 변경됐습니다: ${file.name}`);
      }
    }
    const backup = crypto.randomBytes(16).toString('hex');
    const backupDir = await safeDirectory(path.join(modsDir, '.mc-devkit-backups', backup), true);
    const journal = { backup, before, files: [] };
    for (const file of [...changed, ...removed]) {
      const dest = path.join(modsDir, file.name);
      const existed = await fs.pathExists(dest);
      if (existed) await fs.copyFile(dest, path.join(backupDir, file.name));
      journal.files.push({ name: file.name, existed });
    }
    await writeJsonAtomic(path.join(backupDir, 'previous-manifest.json'), before);
    await writeJsonAtomic(path.join(modsDir, JOURNAL), journal);
    try {
      for (const file of removed) await fs.remove(path.join(modsDir, file.name));
      for (const file of changed) await fs.copyFile(path.join(stage, file.name), path.join(modsDir, file.name));
      await writeJsonAtomic(path.join(modsDir, STATE), manifest);
      await fs.remove(path.join(modsDir, JOURNAL));
    } catch (error) {
      await rollback(modsDir, journal);
      throw error;
    }
    return { status: 'updated', message: `${changed.length}개 설치 · ${removed.length}개 제거. 다음 게임 실행부터 적용됩니다.`,
      revision: manifest.revision, backupDir };
  } finally { await fs.remove(stage); }
}

class ModSync {
  constructor(root, { request = axios.get, isRunning = gameRunning, onChange = () => {} } = {}) {
    this.root = root;
    this.file = path.join(root, 'subscriptions.json');
    this.request = request;
    this.isRunning = isRunning;
    this.onChange = onChange;
    this.subscriptions = [];
    this.locks = new Map();
  }

  async init() {
    this.subscriptions = await fs.readJson(this.file).catch(e => {
      if (e.code === 'ENOENT') return [];
      throw new Error('참가 목록 파일을 읽을 수 없습니다. 원본 파일을 확인하세요.');
    });
    if (!Array.isArray(this.subscriptions)) throw new Error('참가 목록 형식이 잘못됐습니다.');
    this.timer = setInterval(() => this.poll(), 15000);
    this.timer.unref?.();
    this.poll();
  }

  async persist() { await writeJsonAtomic(this.file, this.subscriptions); }

  list() {
    return this.subscriptions.map(({ token, ...sub }) => ({ ...sub }));
  }

  async fetchManifest(sub) {
    const { data } = await this.request(`${sub.origin}/api/packs/${sub.id}/manifest`, {
      headers: { 'X-Pack-Token': sub.token }, timeout: 15000, maxRedirects: 0, maxContentLength: 512 * 1024,
    });
    validateManifest(data);
    if (data.id !== sub.id) throw new Error('초대 링크와 모드팩이 일치하지 않습니다.');
    return data;
  }

  async join(invite, instanceDir, launcher) {
    const connection = parseInvite(invite);
    const instance = await safeDirectory(instanceDir);
    if (path.basename(instance).toLowerCase() === 'mods') throw new Error('mods 폴더의 상위 게임 폴더를 선택하세요.');
    const modsDir = await safeDirectory(path.join(instance, 'mods'), true);
    const sameFolder = this.subscriptions.find(s => s.modsDir.toLowerCase() === modsDir.toLowerCase());
    if (sameFolder && sameFolder.id !== connection.id) {
      throw new Error('이 게임 폴더는 다른 서버에 연결돼 있습니다. 서버·버전별 별도 인스턴스를 선택하세요.');
    }
    const manifest = await this.fetchManifest(connection);
    const state = await readState(modsDir);
    if (state && state.id !== connection.id) throw new Error('다른 서버 모드가 관리되고 있는 폴더입니다. 새 인스턴스를 선택하세요.');
    const sub = { ...connection, key: sameFolder?.key || crypto.randomBytes(16).toString('hex'),
      modsDir, launcher: String(launcher || 'official').slice(0, 30), name: manifest.name,
      minecraft: manifest.minecraft, loader: manifest.loader, enabled: true, status: 'pending', message: '첫 동기화를 준비합니다.' };
    if (sameFolder) this.subscriptions.splice(this.subscriptions.indexOf(sameFolder), 1, sub);
    else this.subscriptions.push(sub);
    await this.persist();
    await this.sync(sub.key);
    return this.list();
  }

  async sync(key) {
    const sub = this.subscriptions.find(s => s.key === key);
    if (!sub) throw new Error('참가 중인 서버를 찾을 수 없습니다.');
    if (this.locks.has(sub.modsDir)) return this.locks.get(sub.modsDir);
    const work = this.performSync(sub);
    this.locks.set(sub.modsDir, work);
    try { return await work; } finally { this.locks.delete(sub.modsDir); }
  }

  async performSync(sub) {
    sub.status = 'syncing';
    sub.message = '호스트의 모드팩을 확인하고 있습니다.';
    this.onChange(this.list());
    try {
      const manifest = await this.fetchManifest(sub);
      // A channel's Minecraft version and loader are pinned to its game instance.
      if (manifest.minecraft !== sub.minecraft || manifest.loader !== sub.loader) throw new Error('게임 버전 또는 로더가 바뀌었습니다. 새 버전용 게임 인스턴스로 다시 참가하세요.');
      const result = await installManifest(sub.modsDir, manifest, async file => {
        const response = await this.request(`${sub.origin}/api/packs/${sub.id}/files/${file.sha256}`, {
          headers: { 'X-Pack-Token': sub.token }, timeout: 120000, responseType: 'arraybuffer',
          maxRedirects: 0, maxContentLength: file.size, maxBodyLength: MAX_FILE,
        });
        return Buffer.from(response.data);
      }, this.isRunning);
      Object.assign(sub, result, { checkedAt: new Date().toISOString() });
    } catch (e) {
      sub.status = 'error';
      // Avoid persisting HTTP request objects or credentials in error messages.
      sub.message = e.response ? `호스트 응답 ${e.response.status}. 호스트 실행 상태와 참가 링크를 확인하세요.`
        : e.isAxiosError ? '호스트에 연결할 수 없습니다. 앱이 실행 중인지, 공유 주소가 바뀌지 않았는지 확인하세요.' : e.message;
    }
    await this.persist();
    this.onChange(this.list());
    return this.list();
  }

  async update(key, enabled) {
    const sub = this.subscriptions.find(s => s.key === key);
    if (!sub) throw new Error('서버를 찾을 수 없습니다.');
    sub.enabled = !!enabled;
    await this.persist();
    return this.list();
  }

  async leave(key) {
    const sub = this.subscriptions.find(s => s.key === key);
    if (sub && this.locks.has(sub.modsDir)) await this.locks.get(sub.modsDir);
    this.subscriptions = this.subscriptions.filter(s => s.key !== key);
    await this.persist();
    return this.list(); // Installed mods and backups deliberately remain on disk.
  }

  poll() { for (const sub of this.subscriptions) if (sub.enabled) this.sync(sub.key).catch(() => {}); }
  async close() { clearInterval(this.timer); await Promise.allSettled([...this.locks.values()]); }
}

module.exports = { ModSync, installManifest, parseInvite, readState };
