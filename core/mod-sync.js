'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { gameRunning } = require('./game-process');
const { MAX_FILE, MAX_PACK, hashFile, validName, regularFile, safeDirectory,
  validateManifest, writeJsonAtomic, packPath } = require('./pack-utils');

function parseInvite(invite) {
  const url = new URL(invite);
  const id = url.searchParams.get('join');
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || !/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('호스트가 복사한 모드팩 참가 링크를 입력하세요.');
  return { id, token, origin: url.origin };
}

const { installManifest, readState } = require('./sync-installer');
const { detectInstance, assertEnvironment } = require('./launcher-profiles');
const CLIENT_VERSION = require('../package.json').version;

class ModSync {
  constructor(root, { request = axios.get, report = axios.post, isRunning = gameRunning, onChange = () => {} } = {}) {
    this.root = root;
    this.file = path.join(root, 'subscriptions.json');
    this.request = request;
    this.report = report;
    this.isRunning = isRunning;
    this.onChange = onChange;
    this.subscriptions = [];
    this.locks = new Map();
    this.starting = new Set();
  }

  async init() {
    this.subscriptions = await fs.readJson(this.file).catch(e => {
      if (e.code === 'ENOENT') return [];
      throw new Error('참가 목록 파일을 읽을 수 없습니다. 원본 파일을 확인하세요.');
    });
    if (!Array.isArray(this.subscriptions)) throw new Error('참가 목록 형식이 잘못됐습니다.');
    for (const sub of this.subscriptions) sub.clientId ||= crypto.randomBytes(16).toString('hex');
    this.timer = setInterval(() => this.poll(), 15000);
    this.timer.unref?.();
    this.poll();
  }

  async persist() { await writeJsonAtomic(this.file, this.subscriptions); }

  list() {
    return this.subscriptions.map(({ token, integrity, ...sub }) => ({ ...sub }));
  }

  async fetchManifest(sub) {
    const { data } = await this.request(`${sub.origin}/api/packs/${sub.id}/manifest`, {
      headers: { 'X-Pack-Token': sub.token, 'X-DevKit-Version': CLIENT_VERSION }, timeout: 15000, maxRedirects: 0, maxContentLength: 512 * 1024,
    });
    validateManifest(data);
    if (data.id !== sub.id) throw new Error('초대 링크와 모드팩이 일치하지 않습니다.');
    return data;
  }

  async join(invite, instanceDir, launcher, options = {}) {
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
    Object.assign(sub, { clientId: sameFolder?.clientId || crypto.randomBytes(16).toString('hex'), nickname: String(options.nickname || '참가자').slice(0,60),
      syncConfig: options.syncConfig === true, environment: options.environment || null,
      acknowledged: options.acknowledged === true, loaderVersion: manifest.loaderVersion || '', launchPath: sameFolder?.launchPath || null });
    if (manifest.schema === 2) assertEnvironment(await detectInstance(instance, launcher, sub.environment || {}), manifest, sub);
    if (sameFolder) this.subscriptions.splice(this.subscriptions.indexOf(sameFolder), 1, sub);
    else this.subscriptions.push(sub);
    await this.persist();
    this.onChange(this.list());
    await this.sendReport(sub);
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
      if (manifest.minecraft !== sub.minecraft || manifest.loader !== sub.loader || (manifest.loaderVersion || '') !== (sub.loaderVersion || '')) throw new Error('게임 버전 또는 로더가 바뀌었습니다. 새 버전용 게임 인스턴스로 다시 참가하세요.');
      if (manifest.schema === 2) assertEnvironment(await detectInstance(path.dirname(sub.modsDir), sub.launcher, sub.environment || {}), manifest, sub);
      const result = await installManifest(sub.modsDir, manifest, async file => {
        const response = await this.request(`${sub.origin}/api/packs/${sub.id}/files/${file.sha256}`, {
          headers: { 'X-Pack-Token': sub.token }, timeout: 120000, responseType: 'arraybuffer',
          maxRedirects: 0, maxContentLength: file.size, maxBodyLength: MAX_FILE,
        });
        return Buffer.from(response.data);
      }, this.isRunning, { syncConfig: sub.syncConfig });
      Object.assign(sub, result, { checkedAt: new Date().toISOString() });
      if(['current','updated'].includes(sub.status)) {
        sub.integrity=[];
        for(const file of manifest.files){const name=packPath(file,manifest),stat=await regularFile(path.join(path.dirname(sub.modsDir),...name.split('/')));sub.integrity.push({name,size:stat.size,mtime:stat.mtimeMs});}
      }
    } catch (e) {
      sub.status = 'error';
      // Avoid persisting HTTP request objects or credentials in error messages.
      sub.message = e.response?.status===426?'MC DevKit을 최신 버전으로 업데이트하세요.':e.response?.status===401?'초대가 만료됐습니다. 새 참가 링크로 다시 연결하세요.':e.response ? `호스트 응답 ${e.response.status}. 호스트 실행 상태와 참가 링크를 확인하세요.`
        : e.isAxiosError ? '호스트에 연결할 수 없습니다. 앱이 실행 중인지, 공유 주소가 바뀌지 않았는지 확인하세요.' : e.message;
    }
    await this.persist();
    await this.sendReport(sub);
    this.onChange(this.list());
    return this.list();
  }

  async update(key, enabled) {
    const sub = this.subscriptions.find(s => s.key === key);
    if (!sub) throw new Error('서버를 찾을 수 없습니다.');
    if (typeof enabled === 'object' && enabled) {
      for (const field of ['enabled','syncConfig','acknowledged']) if (typeof enabled[field] === 'boolean') sub[field]=enabled[field];
      if (typeof enabled.nickname === 'string') sub.nickname = enabled.nickname.slice(0,60);
    } else sub.enabled = !!enabled;
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

  async sendReport(sub) {
    await this.report(`${sub.origin}/api/packs/${sub.id}/report`, { clientId:sub.clientId, name:sub.nickname || '참가자',
      status:sub.enabled?sub.status:'paused', revision:sub.revision, clientVersion:CLIENT_VERSION,
      message: ['error','environment-error'].includes(sub.status)?'환경 확인 또는 적용 실패. 참가자 앱에서 상세 원인을 확인하세요.':sub.message },
      { headers:{'X-Pack-Token':sub.token},timeout:5000,maxRedirects:0 }).catch(()=>{});
  }

  async startGame(key, launch) {
    if(this.starting.has(key))throw Error('게임 시작을 준비 중입니다.');
    const sub=this.subscriptions.find(s=>s.key===key);
    if(!sub)throw Error('참가 중인 서버를 찾을 수 없습니다.');
    this.starting.add(key);
    try {
    if(this.locks.has(sub.modsDir))await this.locks.get(sub.modsDir);
    if(this.locks.has(sub.modsDir))throw Error('게임 시작을 준비 중입니다.');
    const work=(async()=>{
      for(let attempt=0;attempt<3;attempt++) {
        await this.performSync(sub);
        if(!['current','updated'].includes(sub.status))throw Error(sub.message);
        const latest=await this.fetchManifest(sub);
        if(latest.revision!==sub.revision)continue;
        if(await this.isRunning())throw Error('Minecraft가 이미 실행 중입니다. 먼저 종료하세요.');
        return { subscriptions:this.list(), ...await launch({...sub}) };
      }
      throw Error('호스트 배포가 계속 변경 중입니다. 잠시 후 게임 시작을 다시 누르세요.');
    })();
    this.locks.set(sub.modsDir,work);
    try{return await work;}finally{this.locks.delete(sub.modsDir);}
    } finally {this.starting.delete(key);}
  }

  poll() {
    for (const sub of this.subscriptions) {
      if (this.locks.has(sub.modsDir)) continue;
      const work=(async()=>{
        if(sub.enabled)try {
          const manifest=await this.fetchManifest(sub);
          if(manifest.revision!==sub.revision) {sub.status='pending';sub.message='새 승인 배포가 있습니다. 게임 시작을 누르면 자동 적용됩니다.';}
          else if(['current','updated'].includes(sub.status))for(const file of sub.integrity || []) {
            const stat=await fs.lstat(path.join(path.dirname(sub.modsDir),...file.name.split('/'))).catch(()=>null);
            if(!stat?.isFile() || stat.isSymbolicLink() || stat.size!==file.size || stat.mtimeMs!==file.mtime){sub.status='pending';sub.message='게임 파일이 변경됐습니다. 게임 시작 시 다시 확인하고 적용합니다.';break;}
          }
        }catch(e){sub.status='error';sub.message=e.response?.status===401?'초대가 만료됐습니다. 새 참가 링크로 다시 연결하세요.':'호스트 연결을 확인하세요.';}
        await this.sendReport(sub);this.onChange(this.list());
      })();
      this.locks.set(sub.modsDir,work);
      work.finally(()=>{if(this.locks.get(sub.modsDir)===work)this.locks.delete(sub.modsDir);}).catch(()=>{});
    }
  }
  async close() { clearInterval(this.timer); await Promise.allSettled([...this.locks.values()]); }
}

module.exports = { ModSync, installManifest, parseInvite, readState };
