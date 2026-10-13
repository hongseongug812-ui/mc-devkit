'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const PackPublisher = require('./pack-publisher');
const { inspectPack } = require('./mod-inspector');
const { MAX_FILE, MAX_FILES, validPackPath, regularFile, safeDirectory, hashFile,
  revisionOf, validateManifest, writeJsonAtomic, packPath } = require('./pack-utils');

const MODES = ['review', 'auto', 'filming'];
const STATUS = ['current','updated','waiting','error','syncing','pending','config-pending','paused','environment-error'];
const matches = (name, patterns) => patterns.some(p => new RegExp('^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(name));

class StudioPublisher extends PackPublisher {
  constructor(root, onChange, onError, { inspect = inspectPack } = {}) {
    super(root, onChange, onError);
    this.inspect = inspect;
  }

  file(id, name) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('잘못된 서버 ID');
    return path.join(this.root, id, name);
  }

  readChannel(id) { return fs.readJson(this.file(id, 'channel.json')); }

  async getChannel(config, name) {
    const channel = await super.getChannel(config, name);
    if (!channel.mode) {
      Object.assign(channel, { mode: 'review', loaderVersion: config.loaderVersion || '', configSourceDir: path.join(path.dirname(channel.sourceDir), 'config'), configPatterns: [], inviteEnabled: true });
      await this.save(channel);
    }
    return channel;
  }

  async configure(channel, settings) {
    return this.serial(channel.id, () => this.configureLocked(channel, settings));
  }

  async configureLocked(channel, settings) {
    channel = await this.readChannel(channel.id);
    if (settings.mode !== undefined && !MODES.includes(settings.mode)) throw Error('잘못된 배포 모드');
    if (settings.loaderVersion !== undefined && !/^[\w.+-]{0,80}$/.test(settings.loaderVersion)) throw Error('로더 버전을 확인하세요.');
    if (settings.configPatterns !== undefined && (!Array.isArray(settings.configPatterns) || settings.configPatterns.length > 50
      || settings.configPatterns.some(p => typeof p !== 'string' || !p || p.length > 200 || p.includes('..') || /[<>:"\\|?\x00-\x1f]/.test(p) || p.startsWith('/')))) throw Error('공용 설정 파일 규칙을 확인하세요.');
    const active = await this.manifest(channel.id).catch(() => null);
    if (settings.mode === 'filming' && !active) throw Error('먼저 정상 배포를 승인한 뒤 촬영 모드를 켜세요.');
    if (active?.schema === 2 && settings.loaderVersion !== undefined && active.loaderVersion !== settings.loaderVersion) throw Error('승인된 로더 버전은 변경할 수 없습니다. 새 서버 프로필로 분리하세요.');
    const updated = await super.configure(channel, settings);
    updated.mode = settings.mode || channel.mode || 'review';
    updated.loaderVersion = settings.loaderVersion ?? channel.loaderVersion ?? '';
    updated.configPatterns = settings.configPatterns ?? channel.configPatterns ?? [];
    if (settings.configSourceDir) updated.configSourceDir = await safeDirectory(settings.configSourceDir, true);
    updated.configSourceDir ||= path.join(path.dirname(updated.sourceDir), 'config');
    if (updated.mode === 'filming') {
      const active = await this.manifest(channel.id).catch(() => null);
      if (!active) throw Error('먼저 정상 배포를 승인한 뒤 촬영 모드를 켜세요.');
      updated.pinnedRevision = active.revision;
    } else updated.pinnedRevision = null;
    await this.save(updated);
    await this.watchers.get(channel.id)?.close();
    this.watchers.delete(channel.id);
    if (updated.autoPublish) this.watch(updated);
    return updated;
  }

  watch(channel) {
    this.watchers.get(channel.id)?.close();
    const dirs = [channel.sourceDir, ...(channel.configPatterns?.length ? [channel.configSourceDir] : [])];
    const watcher = chokidar.watch(dirs, { ignoreInitial: true, depth: 7,
      awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 250 } });
    watcher.on('all', (_, file) => {
      if (!/\.(jar|json|json5|toml|cfg|conf|properties|yaml|yml|txt)$/i.test(file)) return;
      clearTimeout(this.timers.get(channel.id));
      this.timers.set(channel.id, setTimeout(() => {
        this.timers.delete(channel.id);
        this.readChannel(channel.id).then(ch => this.publish(ch)).catch(this.onError);
      }, 5000));
    });
    watcher.on('error', this.onError);
    this.watchers.set(channel.id, watcher);
  }

  async collect(channel) {
    await safeDirectory(channel.sourceDir, true);
    const sources = (await fs.readdir(channel.sourceDir)).filter(n => n.toLowerCase().endsWith('.jar') && matches(n, channel.patterns || ['*.jar']))
      .map(n => ({ name: `mods/${n}`, path: path.join(channel.sourceDir, n) }));
    if (channel.configPatterns?.length) {
      const root = await safeDirectory(channel.configSourceDir, true);
      const walk = async (relative = '', depth = 0) => {
        if (depth > 6) return;
        const dir = await safeDirectory(path.join(root, relative));
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw Error('공용 설정에 연결 파일이 있습니다. 실제 파일을 사용하세요.');
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(rel, depth + 1);
          else if (entry.isFile() && matches(rel, channel.configPatterns)) {
            if (!validPackPath(`config/${rel}`)) throw Error(`개인 설정 또는 배포할 수 없는 설정 파일: ${rel}`);
            sources.push({ name: `config/${rel}`, path: path.join(root, ...rel.split('/')) });
          }
          if (sources.length > MAX_FILES) throw Error('배포 파일은 최대 500개입니다.');
        }
      };
      await walk();
    }
    sources.sort((a,b) => a.name.localeCompare(b.name));
    if (sources.length > MAX_FILES) throw Error('배포 파일은 최대 500개입니다.');
    for (const file of sources) {
      if (!validPackPath(file.name)) throw Error(`배포할 수 없는 파일: ${file.name}`);
      const stat = await regularFile(file.path);
      if (!stat.size || stat.size > MAX_FILE) throw Error(`파일 크기를 확인하세요: ${file.name}`);
      file.size = stat.size; file.mtime = stat.mtimeMs;
    }
    return sources;
  }

  async snapshot(input) {
    const channel = await this.readChannel(input.id);
    const sources = await this.collect(channel);
    const objectDir = this.file(channel.id, 'objects');
    await fs.ensureDir(objectDir);
    const files = [], inspectFiles = [];
    for (const source of sources) {
      const hash = await hashFile(source.path);
      const object = path.join(objectDir, hash);
      if (!await fs.pathExists(object)) {
        const temp = `${object}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
          await fs.copyFile(source.path, temp);
          if (await hashFile(temp) !== hash) throw Error('파일이 변경 중입니다. 다시 준비하세요.');
          await fs.rename(temp, object);
        } finally { await fs.remove(temp); }
      }
      files.push({ name: source.name, size: source.size, sha256: hash });
      if (source.name.startsWith('mods/')) inspectFiles.push({ name: source.name, path: object });
    }
    const after = await this.collect(channel);
    if (JSON.stringify(sources.map(f=>[f.name,f.size,f.mtime])) !== JSON.stringify(after.map(f=>[f.name,f.size,f.mtime]))) throw Error('배포 준비 중 원본 폴더가 변경됐습니다. 파일 교체를 마친 뒤 다시 준비하세요.');
    for (let i = 0; i < sources.length; i++) if (await hashFile(sources[i].path) !== files[i].sha256) throw Error('배포 준비 중 파일이 변경됐습니다.');
    const validation = await this.inspect(inspectFiles, channel);
    const manifest = { schema: 2, id: channel.id, name: channel.name, minecraft: channel.minecraft,
      loader: channel.loader, loaderVersion: channel.loaderVersion || '', files, publishedAt: new Date().toISOString(), minClientVersion: '1.9.0' };
    manifest.revision = revisionOf(manifest);
    validateManifest(manifest);
    const active = await this.manifest(channel.id).catch(() => null);
    const old = new Map((active?.files || []).map(f => [packPath(f,active), f.sha256]));
    const next = new Map(files.map(f => [f.name,f.sha256]));
    const diff = { added: [...next.keys()].filter(n=>!old.has(n)), changed: [...next.keys()].filter(n=>old.has(n) && old.get(n)!==next.get(n)), removed: [...old.keys()].filter(n=>!next.has(n)) };
    const pending = { manifest, validation, diff, preparedAt: new Date().toISOString() };
    await writeJsonAtomic(this.file(channel.id,'pending.json'), pending);
    if (active) await this.archive(active);
    // Automatic mode still blocks empty packs and validation failures.
    if (channel.mode === 'auto' && !validation.errors.length && files.length && active?.revision !== manifest.revision) await this.activate(channel, pending, false);
    this.onChange({ ...manifest, prepared: true });
    return manifest;
  }

  pending(id) { return fs.readJson(this.file(id,'pending.json')).catch(() => null); }

  async archive(manifest) {
    validateManifest(manifest);
    await writeJsonAtomic(this.file(manifest.id,`releases/${manifest.revision}.json`), manifest);
  }

  async activate(channel, pending, allowEmpty) {
    channel = await this.readChannel(channel.id);
    if (channel.mode === 'filming') throw Error('촬영 중에는 배포를 바꿀 수 없습니다. 촬영 모드를 먼저 해제하세요.');
    if (pending.validation?.errors?.length) throw Error('모드 검사 오류를 해결한 뒤 배포하세요.');
    const manifest = validateManifest(pending.manifest);
    if (!manifest.files.length && !allowEmpty) throw Error('빈 배포는 모든 관리 파일을 제거합니다. 변경 목록을 확인하고 빈 배포 승인을 선택하세요.');
    const before = await this.manifest(channel.id).catch(() => null);
    if (before) await this.archive(before);
    const active = { ...manifest, publishedAt: new Date().toISOString() };
    await this.archive(active);
    await writeJsonAtomic(this.file(channel.id,'manifest.json'), active);
    this.onChange(active);
    return active;
  }

  async promote(id, expectedRevision, allowEmpty = false) {
    return this.serial(id, async () => {
      const pending = await this.pending(id);
      if (!pending || pending.manifest.revision !== expectedRevision) throw Error('준비된 배포가 바뀌었습니다. 변경 목록을 다시 확인하세요.');
      return this.activate(await this.readChannel(id), pending, allowEmpty);
    });
  }

  async serial(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const job = previous.catch(()=>{}).then(fn); this.locks.set(id,job);
    try { return await job; } finally { if (this.locks.get(id)===job) this.locks.delete(id); }
  }

  async history(id) {
    const dir = this.file(id, 'releases');
    const names = await fs.readdir(dir).catch(()=>[]);
    const items = [];
    for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const manifest = await fs.readJson(path.join(dir,name)); validateManifest(manifest); items.push(manifest);
    }
    return items.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
  }

  async restore(id, revision) {
    return this.serial(id, async () => {
      if (!/^[a-f0-9]{64}$/.test(revision)) throw Error('잘못된 배포 버전');
      const channel = await this.readChannel(id);
      if (channel.mode === 'filming') throw Error('촬영 모드를 해제한 뒤 복원하세요.');
      const manifest = validateManifest(await fs.readJson(this.file(id, `releases/${revision}.json`)));
      for (const file of manifest.files) {
        const object = this.file(id, `objects/${file.sha256}`);
        if (await hashFile(object) !== file.sha256) throw Error('복원 파일 검증 실패');
      }
      channel.mode = 'review'; await this.save(channel);
      return this.activate(channel, { manifest, validation: { errors: [] } }, true);
    });
  }

  async setMode(id, mode) {
    if (!MODES.includes(mode)) throw Error('잘못된 배포 모드');
    return this.serial(id, async () => {
      const channel = await this.readChannel(id);
      const active = await this.manifest(id).catch(()=>null);
      if (mode==='filming' && !active) throw Error('먼저 배포를 승인하세요.');
      channel.mode=mode; channel.pinnedRevision=mode==='filming' ? active.revision : null;
      await this.save(channel); return channel;
    });
  }

  async invite(id, action) {
    return this.serial(id, async () => {
      const channel=await this.readChannel(id);
      if(action==='rotate') { channel.token=crypto.randomBytes(32).toString('hex');channel.inviteEnabled=true; }
      else if(action==='revoke') channel.inviteEnabled=false;
      else throw Error('잘못된 초대 작업');
      await this.save(channel);return channel;
    });
  }

  async authorized(id, token) {
    const channel=await this.readChannel(id).catch(()=>null);
    if (!channel || channel.inviteEnabled===false) return false;
    return super.authorized(id,token);
  }

  async report(id, body) {
    if (!body || !/^[a-f0-9]{32}$/.test(body.clientId) || !STATUS.includes(body.status)
      || (body.revision && !/^[a-f0-9]{64}$/.test(body.revision))) throw Error('잘못된 준비 상태');
    return this.serial(id, async()=> {
      const file=this.file(id,'participants.json');
      const list=await fs.readJson(file).catch(()=>({}));
      if(!list[body.clientId] && Object.keys(list).length>=200)throw Error('참가자가 너무 많습니다.');
      list[body.clientId]={ clientId:body.clientId, name:String(body.name||'참가자').slice(0,60), status:body.status,
        revision:body.revision||null, message:String(body.message||'').slice(0,400), checkedAt:new Date().toISOString(), clientVersion:String(body.clientVersion||'').slice(0,30) };
      await writeJsonAtomic(file,list);return {ok:true};
    });
  }

  async participants(id) {
    const list=await fs.readJson(this.file(id,'participants.json')).catch(()=>({}));
    const active=await this.manifest(id).catch(()=>null);
    return Object.values(list).map(p=>({...p, online:Date.now()-Date.parse(p.checkedAt)<60000,
      ready:Date.now()-Date.parse(p.checkedAt)<60000 && ['current','updated'].includes(p.status) && p.revision===active?.revision }));
  }

  async object(id, hash) {
    if(!/^[a-f0-9]{64}$/.test(hash))throw Error('잘못된 파일 해시');
    const current=await this.manifest(id).catch(()=>null);
    if (current?.files.some(f=>f.sha256===hash) || (await this.history(id)).some(m=>m.files.some(f=>f.sha256===hash))) return this.file(id,`objects/${hash}`);
    throw Error('배포에 없는 파일');
  }

  async view(channel) {
    const id=channel.id;
    return { ...await this.readChannel(id), manifest:await this.manifest(id).catch(()=>null), pending:await this.pending(id),
      history:(await this.history(id)).slice(0,30).map(m=>({revision:m.revision,publishedAt:m.publishedAt,files:m.files.length,minecraft:m.minecraft})), participants:await this.participants(id) };
  }
}

module.exports=StudioPublisher;
