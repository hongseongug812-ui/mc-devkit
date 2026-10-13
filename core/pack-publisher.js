'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { MAX_FILE, MAX_FILES, validName, regularFile, safeDirectory, hashFile, sha256,
  revisionOf, validateManifest, writeJsonAtomic } = require('./pack-utils');

class PackPublisher {
  constructor(root, onChange = () => {}, onError = () => {}) {
    this.root = root;
    this.onChange = onChange;
    this.onError = onError;
    this.watchers = new Map();
    this.locks = new Map();
    this.channelLocks = new Map();
    this.timers = new Map();
  }

  async init() {
    await fs.ensureDir(this.root);
    for (const id of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{32}$/.test(id)) continue;
      try {
        const channel = await fs.readJson(path.join(this.root, id, 'channel.json'));
        if (channel.autoPublish) {
          this.watch(channel);
          await this.publish(channel);
        }
      } catch (e) { this.onError(e); }
    }
  }

  async channel(config, name) {
    const key = JSON.stringify([config.serverDir, config.serverFolder, config.serverType, config.paperVersion,config.loaderVersion||'']);
    if (this.channelLocks.has(key)) return this.channelLocks.get(key);
    const task = this.getChannel(config, name);
    this.channelLocks.set(key, task);
    try { return await task; } finally { this.channelLocks.delete(key); }
  }

  async getChannel(config, name) {
    const identity=[path.resolve(config.serverDir).toLowerCase(),config.serverFolder || config.serverType, config.serverType, config.paperVersion];
    if(config.loaderVersion)identity.push(config.loaderVersion);
    const key = sha256(JSON.stringify(identity));
    await fs.ensureDir(this.root);
    for (const id of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{32}$/.test(id)) continue;
      const ch = await fs.readJson(path.join(this.root, id, 'channel.json')).catch(() => null);
      if (ch?.key === key) return ch;
    }
    const channel = { id: crypto.randomBytes(16).toString('hex'), key,
      token: crypto.randomBytes(32).toString('hex'), name: String(name || config.serverFolder || '내 서버').slice(0, 200),
      minecraft: config.paperVersion, loader: ['forge','neoforge'].includes(config.serverType) ? config.serverType : config.serverType === 'arclight' ? 'forge'
        : ['fabric', 'cardboard'].includes(config.serverType) ? 'fabric' : 'none',
      sourceDir: path.resolve(config.serverDir, config.serverFolder || config.serverType, 'client-mods'), patterns: ['*.jar'], autoPublish: false };
    await this.save(channel);
    return channel;
  }

  save(channel) { return writeJsonAtomic(path.join(this.root, channel.id, 'channel.json'), channel); }

  async configure(channel, settings) {
    const updated = { ...channel };
    if (settings.patterns !== undefined) {
      if (!Array.isArray(settings.patterns) || !settings.patterns.length || settings.patterns.length > 50
        || settings.patterns.some(p => typeof p !== 'string' || p.length > 180 || !/^[^<>:"/\\|?\x00-\x1f]+\.jar$/i.test(p) || p.startsWith('.'))) throw new Error('파일 규칙을 확인하세요. 예: creator-*.jar, fabric-api-*.jar');
      updated.patterns = settings.patterns;
    }
    if (settings.sourceDir) updated.sourceDir = await safeDirectory(settings.sourceDir, true);
    if (settings.loader && ['fabric', 'forge', 'neoforge', 'none'].includes(settings.loader)) {
      const published = await this.manifest(channel.id).catch(() => null);
      if (published && published.loader !== settings.loader) throw new Error('배포된 로더는 변경할 수 없습니다. 새 서버 프로필로 분리하세요.');
      updated.loader = settings.loader;
    }
    updated.autoPublish = !!settings.autoPublish;
    await this.save(updated);
    clearTimeout(this.timers.get(channel.id));
    this.timers.delete(channel.id);
    await this.watchers.get(channel.id)?.close();
    this.watchers.delete(channel.id);
    if (updated.autoPublish) this.watch(updated);
    return updated;
  }

  watch(channel) {
    const watcher = chokidar.watch(channel.sourceDir, { ignoreInitial: true, depth: 0,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 } });
    watcher.on('all', (_, file) => {
      if (!file.toLowerCase().endsWith('.jar')) return;
      clearTimeout(this.timers.get(channel.id));
      this.timers.set(channel.id, setTimeout(() => {
        this.timers.delete(channel.id);
        this.publish(channel).catch(this.onError);
      }, 1000));
    });
    watcher.on('error', this.onError);
    this.watchers.set(channel.id, watcher);
  }

  async publish(channel) {
    // Serialize snapshots so a slow publish cannot overwrite a newer revision.
    const previous = this.locks.get(channel.id) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.snapshot(channel));
    this.locks.set(channel.id, job);
    try { return await job; } finally { if (this.locks.get(channel.id) === job) this.locks.delete(channel.id); }
  }

  async snapshot(channel) {
    await safeDirectory(channel.sourceDir, true);
    const patterns = (channel.patterns || ['*.jar']).map(pattern => new RegExp('^' + pattern.split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'));
    const names = (await fs.readdir(channel.sourceDir)).filter(n => n.toLowerCase().endsWith('.jar') && patterns.some(p => p.test(n))).sort();
    if (names.length > MAX_FILES) throw new Error('모드 파일은 최대 500개까지 배포할 수 있습니다.');
    const files = [];
    const packDir = path.join(this.root, channel.id);
    await fs.ensureDir(path.join(packDir, 'objects'));
    for (const name of names) {
      if (!validName(name)) throw new Error(`배포할 수 없는 파일명: ${name}`);
      const source = path.join(channel.sourceDir, name);
      const stat = await regularFile(source);
      if (stat.size <= 0 || stat.size > MAX_FILE) throw new Error(`파일 크기를 확인하세요: ${name} (최대 256MB)`);
      const hash = await hashFile(source);
      const object = path.join(packDir, 'objects', hash);
      if (!await fs.pathExists(object)) {
        const temp = `${object}.tmp`;
        try {
          await fs.copyFile(source, temp);
          if (await hashFile(temp) !== hash) throw new Error('모드 파일이 변경 중입니다. 잠시 후 다시 배포하세요.');
          await fs.rename(temp, object);
        } finally { await fs.remove(temp); }
      }
      files.push({ name, size: stat.size, sha256: hash });
    }
    const manifest = { schema: 1, id: channel.id, name: channel.name, minecraft: channel.minecraft,
      loader: channel.loader, files, publishedAt: new Date().toISOString() };
    manifest.revision = revisionOf(manifest);
    validateManifest(manifest);
    const before = await this.manifest(channel.id).catch(() => null);
    if (before?.revision === manifest.revision) return before;
    await writeJsonAtomic(path.join(packDir, 'manifest.json'), manifest);
    this.onChange(manifest);
    return manifest;
  }

  async authorized(id, token) {
    if (!/^[a-f0-9]{32}$/.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const channel = await fs.readJson(path.join(this.root, id, 'channel.json')).catch(() => null);
    if (!channel || token.length !== channel.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(channel.token), Buffer.from(token));
  }

  manifest(id) { return fs.readJson(path.join(this.root, id, 'manifest.json')); }

  async object(id, hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('잘못된 파일 해시');
    const manifest = await this.manifest(id);
    if (!manifest.files.some(f => f.sha256 === hash)) throw new Error('현재 배포에 없는 파일입니다. 동기화를 다시 시도하세요.');
    return path.join(this.root, id, 'objects', hash);
  }

  async close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.watchers.values()].map(w => w.close()));
    await Promise.allSettled([...this.locks.values()]);
  }
}

module.exports = PackPublisher;
