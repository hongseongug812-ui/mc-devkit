'use strict';

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { MAX_FILE, MAX_PACK, MAX_FILES, validName, safeDirectory, regularFile, hashFile, sha256, writeJsonAtomic } = require('./pack-utils');
const { readMods } = require('./mod-inspector');

const API = 'https://api.modrinth.com/v2';
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const SIDES = { both: ['client', 'server'], client: ['client'], server: ['server'] };

// The catalog manages server/profile files; publication still follows Studio's review/filming policy.
class ModCatalog {
  constructor(publisher, { request = axios.get, isServerRunning = () => false, isChannelCurrent = () => true, onError = () => {} } = {}) {
    this.publisher = publisher;
    this.request = request;
    this.isServerRunning = isServerRunning;
    this.isChannelCurrent = isChannelCurrent;
    this.onError = onError;
    this.closed = false;
    this.commits = new Set();
    this.queue = Promise.resolve();
  }

  get committing() { return this.commits.size > 0; }

  async api(endpoint, params) {
    try {
      return (await this.request(`${API}${endpoint}`, {
        params, headers: { 'User-Agent': `MC-DevKit/${require('../package.json').version} (github.com/hongseongug812-ui/mc-devkit)` },
        timeout: 20000, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024,
      })).data;
    } catch (error) {
      throw Error(error.response?.status === 429 ? '모드 검색 요청이 많습니다. 잠시 후 다시 시도하세요.' : 'Modrinth에 연결할 수 없습니다. 인터넷 연결과 모드 공개 상태를 확인하세요.');
    }
  }

  environment(channel) {
    if (!['fabric', 'forge', 'neoforge'].includes(channel.loader)) throw Error('모드 검색은 Fabric·Forge·NeoForge 서버에서 사용할 수 있습니다. 서버 설정에서 로더를 먼저 선택하세요.');
    if (!/^\d+\.\d+(\.\d+)?$/.test(channel.minecraft)) throw Error('서버의 Minecraft 버전을 확인하세요.');
  }

  async search(channel, query = '', offset = 0) {
    this.environment(channel);
    if (typeof query !== 'string' || query.length > 120 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw Error('검색어와 페이지를 확인하세요.');
    const result = await this.api('/search', { query: query.trim(), offset, limit: 20, index: query.trim() ? 'relevance' : 'downloads',
      facets: JSON.stringify([['project_type:mod'], [`versions:${channel.minecraft}`], [`categories:${channel.loader}`]]) });
    return { provider: 'Modrinth', minecraft: channel.minecraft, loader: channel.loader, offset,
      total: Number(result.total_hits) || 0, hits: (result.hits || []).slice(0, 20).map(row => ({ projectId: row.project_id,
        slug: row.slug, title: String(row.title || '').slice(0, 200), description: String(row.description || '').slice(0, 500),
        downloads: row.downloads, clientSide: row.client_side, serverSide: row.server_side })) };
  }

  async project(id) {
    if (!validId(id)) throw Error('모드 ID를 확인하세요.');
    const project = await this.api(`/project/${encodeURIComponent(id)}`);
    if (!project || !validId(project.id) || project.project_type !== 'mod') throw Error('설치할 수 있는 모드가 아닙니다.');
    return project;
  }

  compatible(version, channel) {
    return version && validId(version.id) && validId(version.project_id) && version.game_versions?.includes(channel.minecraft)
      && version.loaders?.includes(channel.loader) && !['archived', 'draft', 'unlisted', 'scheduled'].includes(version.status);
  }

  async versions(channel, projectId) {
    this.environment(channel);
    const project = await this.project(projectId);
    const versions = await this.api(`/project/${encodeURIComponent(project.id)}/version`, {
      game_versions: JSON.stringify([channel.minecraft]), loaders: JSON.stringify([channel.loader]),
    });
    return { project: { id: project.id, title: project.title, clientSide: project.client_side, serverSide: project.server_side },
      versions: (Array.isArray(versions) ? versions : []).filter(v => this.compatible(v, channel) && v.project_id === project.id)
        .sort((a, b) => String(b.date_published).localeCompare(String(a.date_published)))
        .slice(0, 100).map(v => ({ id: v.id, name: v.name, versionNumber: v.version_number, type: v.version_type, publishedAt: v.date_published })) };
  }

  registryFile(id) { return this.publisher.file(id, 'catalog-installed.json'); }

  async readRegistry(id) {
    const state = await fs.readJson(this.registryFile(id)).catch(error => {
      if (error.code === 'ENOENT') return { autoUpdate: true, roots: [], files: [] };
      throw Error('모드 설치 기록을 읽을 수 없습니다. 원본 파일을 확인하세요.');
    });
    if (!Array.isArray(state.files) || !Array.isArray(state.roots)) throw Error('모드 설치 기록 형식이 잘못됐습니다.');
    return state;
  }

  summary(state) {
    const items = new Map();
    for (const file of state.files) {
      if (!items.has(file.projectId)) items.set(file.projectId, { projectId: file.projectId, title: file.title,
        versionNumber: file.versionNumber, sides: [], autoUpdate: state.autoUpdate !== false && state.roots.find(root => root.projectId === file.projectId)?.autoUpdate !== false });
      const item = items.get(file.projectId);
      if (!item.sides.includes(file.side)) item.sides.push(file.side);
    }
    return { installed: [...items.values()], autoUpdate: state.autoUpdate !== false, lastChecked: state.lastChecked || null, error: state.error || '' };
  }

  async installed(id) { return this.summary(await this.readRegistry(id)); }

  async settings(id, autoUpdate) {
    if (typeof autoUpdate !== 'boolean') throw Error('자동 업데이트 설정을 확인하세요.');
    return this.publisher.serial(id, async () => {
      const state = await this.readRegistry(id); state.autoUpdate = autoUpdate;
      await writeJsonAtomic(this.registryFile(id), state); return this.summary(state);
    });
  }

  // Resolve every required dependency before writing any game file. Pins from different roots must agree.
  async resolve(channel, roots) {
    this.environment(channel);
    const projects = new Map(), versions = new Map(), chosen = new Map(), visiting = new Set(), plan = [];
    const getProject = async id => {
      if (!projects.has(id)) projects.set(id, this.project(id));
      return projects.get(id);
    };
    const getVersion = async id => {
      if (!validId(id)) throw Error('모드 버전 ID를 확인하세요.');
      if (!versions.has(id)) versions.set(id, this.api(`/version/${encodeURIComponent(id)}`));
      const value = await versions.get(id);
      if (!this.compatible(value, channel)) throw Error('서버 Minecraft 버전·로더와 맞지 않는 모드 버전입니다.');
      return value;
    };
    const latest = async projectId => {
      const result = await this.versions(channel, projectId);
      const release = result.versions.find(v => v.type === 'release');
      if (!release) throw Error(`${result.project.title}: 이 서버 환경에 맞는 정식 버전이 없습니다.`);
      return getVersion(release.id);
    };
    const visit = async (projectId, versionId, sides, root = false, depth = 0) => {
      if (plan.length > MAX_FILES || depth > 50) throw Error('필수 모드 의존성이 너무 많습니다.');
      const version = versionId ? await getVersion(versionId) : await latest(projectId);
      if (projectId && version.project_id !== projectId) throw Error('모드와 버전이 일치하지 않습니다.');
      const project = await getProject(version.project_id);
      const compatibleSides = sides.filter(side => project[`${side}_side`] !== 'unsupported');
      if (root && compatibleSides.length !== sides.length) throw Error(`${project.title}: 선택한 설치 위치를 지원하지 않습니다. 클라이언트 전용 또는 서버 전용을 선택하세요.`);
      if (!compatibleSides.length) return;
      for (const side of compatibleSides) {
        const key = `${project.id}:${side}`, selected = chosen.get(key);
        if (selected && selected !== version.id) throw Error(`${project.title}: 다른 모드가 요구하는 필수 버전과 충돌합니다. 모드 구성을 확인하세요.`);
        chosen.set(key, version.id);
      }
      const key = `${version.id}:${compatibleSides.join(',')}`;
      if (visiting.has(key)) return version;
      visiting.add(key);
      for (const dependency of version.dependencies || []) {
        if (dependency.dependency_type !== 'required') continue;
        if (!dependency.project_id && !dependency.version_id) throw Error(`${project.title}: 자동으로 찾을 수 없는 필수 모드가 있습니다.`);
        await visit(dependency.project_id, dependency.version_id, compatibleSides, false, depth + 1);
      }
      const existing = plan.find(item => item.project.id === project.id && item.version.id === version.id);
      if (existing) existing.sides = [...new Set([...existing.sides, ...compatibleSides])];
      else plan.push({ project, version, sides: compatibleSides });
      return version;
    };
    const resolvedRoots = [];
    for (const root of roots) {
      if (!SIDES[root.target]) throw Error('모드 설치 위치를 확인하세요.');
      const version = await visit(root.projectId, root.versionId, SIDES[root.target], true);
      resolvedRoots.push({ ...root, projectId: version.project_id, versionId: version.id });
    }
    if (plan.length > MAX_FILES) throw Error('설치할 모드가 너무 많습니다.');
    for (const item of plan) {
      for (const dependency of item.version.dependencies || []) {
        if (dependency.dependency_type !== 'incompatible') continue;
        if (plan.some(other => other.sides.some(side => item.sides.includes(side)) &&
          (dependency.version_id ? other.version.id === dependency.version_id : other.project.id === dependency.project_id))) {
          throw Error(`${item.project.title}: 함께 설치할 수 없는 모드가 구성에 있습니다.`);
        }
      }
    }
    return { plan, roots: resolvedRoots };
  }

  async download(item, installed = []) {
    const files = item.version.files || [];
    const file = files.find(f => f.primary && validName(f.filename)) || files.find(f => validName(f.filename));
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE) throw Error(`${item.project.title}: 설치할 JAR 파일을 확인할 수 없습니다.`);
    let url;
    try { url = new URL(file.url); } catch { throw Error('잘못된 모드 다운로드 주소입니다.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com' || url.username || url.password || (url.port && url.port !== '443')) throw Error('Modrinth 공식 배포 파일만 다운로드할 수 있습니다.');
    const algorithm = /^[a-f0-9]{128}$/i.test(file.hashes?.sha512 || '') ? 'sha512' : /^[a-f0-9]{40}$/i.test(file.hashes?.sha1 || '') ? 'sha1' : null;
    if (!algorithm) throw Error('모드 파일 검증 해시가 없습니다.');
    let buffer;
    const cached = installed.find(old => old.projectId === item.project.id && old.versionId === item.version.id && old.name === file.filename);
    if (cached) {
      const existing = path.join(cached.dir, cached.name);
      try {
        await safeDirectory(cached.dir);
        if ((await regularFile(existing)).size === file.size && await hashFile(existing) === cached.sha256) buffer = await fs.readFile(existing);
      } catch { /* A missing cache is downloaded and verified again. */ }
    }
    try {
      if (!buffer) {
        const response = await this.request(url.href, { responseType: 'arraybuffer', timeout: 120000, maxRedirects: 0,
          maxContentLength: file.size, maxBodyLength: MAX_FILE, headers: { 'User-Agent': 'MC-DevKit' } });
        buffer = Buffer.from(response.data);
      }
    } catch { throw Error(`${item.project.title}: 모드 다운로드에 실패했습니다. 다시 시도하세요.`); }
    if (buffer.length !== file.size || crypto.createHash(algorithm).update(buffer).digest('hex') !== file.hashes[algorithm].toLowerCase()) throw Error(`${item.project.title}: 다운로드한 모드 파일의 해시 검증에 실패했습니다.`);
    const mods = await readMods(buffer, file.filename);
    if (!mods.some(mod => !mod.embedded && mod.loader === item.version.loaders.find(l => l === item.loader))) throw Error(`${item.project.title}: 모드 JAR의 로더가 맞지 않습니다.`);
    const relevant = mods.filter(mod => !mod.embedded && mod.loader === item.loader);
    if (item.sides.includes('client') && relevant.some(mod => mod.environment === 'server')) throw Error(`${item.project.title}: 서버 전용 모드는 참가자에게 설치할 수 없습니다.`);
    if (item.sides.includes('server') && relevant.some(mod => mod.environment === 'client')) throw Error(`${item.project.title}: 클라이언트 전용 모드는 서버에 설치할 수 없습니다.`);
    return { name: file.filename, buffer, sha256: sha256(buffer) };
  }

  async install(channel, serverModsDir, { versionId, target = 'both', autoUpdate = true } = {}) {
    if (!SIDES[target] || typeof autoUpdate !== 'boolean' || !validId(versionId)) throw Error('모드 버전과 설치 위치를 확인하세요.');
    return this.run(channel.id, serverModsDir, async state => {
      const version = await this.api(`/version/${encodeURIComponent(versionId)}`);
      if (!this.compatible(version, channel)) throw Error('서버 Minecraft 버전·로더와 맞지 않는 모드 버전입니다.');
      return [...state.roots.filter(root => root.projectId !== version.project_id), { projectId: version.project_id, versionId, target, autoUpdate }];
    });
  }

  async update(id, automatic = false) {
    const state = await this.readRegistry(id);
    if (automatic && state.autoUpdate === false) return this.summary(state);
    if (!state.roots.length) return this.summary(state);
    return this.run(id, state.serverModsDir, async current => {
      const channel = await this.publisher.readChannel(id), roots = [];
      for (const root of current.roots) {
        if (automatic && root.autoUpdate === false) { roots.push(root); continue; }
        const previous = await this.api(`/version/${encodeURIComponent(root.versionId)}`);
        const result = await this.versions(channel, root.projectId);
        const latest = result.versions.find(version => version.type === 'release');
        // An explicitly installed beta stays installed until a newer stable release exists.
        roots.push({ ...root, versionId: latest && String(latest.publishedAt) > String(previous.date_published) ? latest.id : root.versionId });
      }
      return roots;
    });
  }

  run(id, serverModsDir, getRoots) {
    // Different versions/channels of one server can share a mods directory.
    const work = this.queue.catch(() => {}).then(() => this.runLocked(id, serverModsDir, getRoots));
    this.queue = work;
    return work;
  }

  async runLocked(id, serverModsDir, getRoots) {
    if (this.closed) throw Error('앱을 종료하고 있습니다.');
    let updated;
    try {
      updated = await this.publisher.serial(id, async () => {
        const channel = await this.publisher.readChannel(id);
        const originalChannel = { ...channel, patterns: [...(channel.patterns || ['*.jar'])] };
        if (channel.mode === 'filming') throw Error('촬영 모드에서는 모드 구성을 고정합니다. 촬영 종료 후 업데이트하세요.');
        const state = await this.readRegistry(id);
        const environment = { ...state, serverModsDir: serverModsDir || state.serverModsDir };
        if (!await this.isChannelCurrent(channel, environment)) throw Error('이 서버의 Minecraft 버전·로더 설정이 변경됐습니다. 현재 서버 환경의 모드팩에서 관리하세요.');
        const resolved = await this.resolve(channel, await getRoots(state));
        const hasServer = resolved.plan.some(item => item.sides.includes('server'));
        const touchesServer = hasServer || state.files.some(file => file.side === 'server');
        if (touchesServer && await this.isServerRunning()) throw Error('서버 중지 후 모드를 설치·업데이트할 수 있습니다. 다음 자동 확인 때 다시 시도합니다.');
        const clientDir = await safeDirectory(channel.sourceDir, true);
        const serverDir = hasServer ? await safeDirectory(serverModsDir, true) : null;
        const staging = await fs.mkdtemp(path.join(await safeDirectory(this.publisher.file(id, 'catalog-staging'), true), 'install-'));
        const next = [], writes = [], removed = [], committed = [];
        let channelSaved = false, preserveStaging = false;
        let total = 0;
        try {
          for (const item of resolved.plan) {
            item.loader = channel.loader;
            const downloaded = await this.download(item, state.files);
            total += downloaded.buffer.length;
            if (total > MAX_PACK) throw Error('모드 설치 크기가 2GB를 초과합니다.');
            const staged = path.join(staging, `${writes.length}.jar`);
            await fs.writeFile(staged, downloaded.buffer);
            for (const side of item.sides) {
              const dir = side === 'client' ? clientDir : serverDir;
              const destination = path.join(dir, downloaded.name);
              const collision = next.find(file => pathKey(path.join(file.dir, file.name)) === pathKey(destination));
              if (collision && collision.projectId !== item.project.id) throw Error('서로 다른 모드의 파일 이름이 같습니다.');
              const record = { projectId: item.project.id, title: item.project.title, versionId: item.version.id,
                versionNumber: item.version.version_number, dir, side, name: downloaded.name, sha256: downloaded.sha256 };
              next.push(record); writes.push({ destination, staged, record });
            }
          }
          // Recheck all paths and managed hashes after downloads. Never overwrite locally edited jars.
          if (this.closed) throw Error('앱을 종료하고 있습니다.');
          this.commits.add(id);
          if (!await this.isChannelCurrent(channel, environment)) throw Error('다운로드 중 서버의 Minecraft 버전·로더 설정이 변경됐습니다. 현재 서버 환경의 모드팩에서 다시 시도하세요.');
          if (touchesServer && await this.isServerRunning()) throw Error('다운로드 중 서버가 시작됐습니다. 서버 중지 후 다시 시도하세요.');
          if ((await this.publisher.readChannel(id)).mode === 'filming') throw Error('촬영 모드에서는 모드를 변경할 수 없습니다.');
          for (const old of state.files) {
            await safeDirectory(old.dir);
            if (!validName(old.name)) throw Error('모드 설치 기록의 파일명을 확인하세요.');
            const file = path.join(old.dir, old.name);
            if (await fs.pathExists(file)) {
              await regularFile(file);
              if (await hashFile(file) !== old.sha256) throw Error(`${old.name}: 직접 수정한 모드 파일입니다. 원본을 확인하세요.`);
            }
          }
          for (const write of writes) {
            await safeDirectory(path.dirname(write.destination));
            if (await fs.pathExists(write.destination)) {
              await regularFile(write.destination);
              const hash = await hashFile(write.destination);
              if (hash !== write.record.sha256 && !state.files.some(old => pathKey(path.join(old.dir, old.name)) === pathKey(write.destination))) throw Error(`${write.record.name}: 같은 이름의 개인 모드가 있습니다. 파일을 먼저 확인하세요.`);
            }
          }
          const destinations = new Map(writes.map(write => [pathKey(write.destination), write]));
          const basePatterns = originalChannel.patterns.filter(pattern => !(state.catalogPatterns || []).includes(pattern));
          const patterns = [...basePatterns];
          for (const file of next.filter(file => file.side === 'client')) {
            if (!patterns.some(pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(file.name))) patterns.push(file.name);
          }
          if (patterns.length > 50) throw Error('배포 파일 규칙이 너무 많습니다. 배포 환경에서 *.jar 규칙으로 정리하세요.');
          for (const old of state.files) {
            const file = path.join(old.dir, old.name), replacement = destinations.get(pathKey(file));
            if (replacement?.record.sha256 === old.sha256 && await fs.pathExists(file)) continue;
            if (await fs.pathExists(file)) {
              const backup = path.join(staging, `backup-${removed.length}.jar`);
              await fs.copyFile(file, backup); await fs.unlink(file); removed.push({ file, backup });
            }
          }
          for (const write of destinations.values()) {
            if (await fs.pathExists(write.destination)) continue;
            await fs.copyFile(write.staged, write.destination, fs.constants.COPYFILE_EXCL);
            committed.push(write.destination);
          }
          const value = { ...state, roots: resolved.roots, files: next, serverModsDir: serverDir || state.serverModsDir,
            catalogPatterns: patterns.filter(pattern => !basePatterns.includes(pattern)),
            lastChecked: new Date().toISOString(), error: '' };
          if (JSON.stringify(patterns) !== JSON.stringify(originalChannel.patterns)) {
            channel.patterns = patterns;
            await this.publisher.save(channel); channelSaved = true;
          }
          await writeJsonAtomic(this.registryFile(id), value);
          return value;
        } catch (error) {
          for (const file of committed.reverse()) await fs.unlink(file).catch(() => { preserveStaging = true; });
          for (const backup of removed.reverse()) await fs.copyFile(backup.backup, backup.file).catch(() => { preserveStaging = true; });
          if (channelSaved) await this.publisher.save(originalChannel).catch(() => { preserveStaging = true; });
          if (preserveStaging) throw Error(`모드 적용 복구를 완료하지 못했습니다. 서버를 시작하기 전에 백업 폴더를 확인하세요: ${staging}`);
          throw error;
        } finally { this.commits.delete(id); if (!preserveStaging) await fs.remove(staging); }
      });
    } catch (error) {
      // Do not persist HTTP objects, credentials, or arbitrary remote error bodies.
      throw error;
    }
    let pack, preparationError = '';
    try { if (!this.closed) await this.publisher.publish(await this.publisher.readChannel(id)); }
    catch { preparationError = '모드는 설치됐습니다. 배포 준비 버튼으로 검사 결과를 확인하세요.'; }
    pack = await this.publisher.view(await this.publisher.readChannel(id));
    return { ...this.summary(updated), pack, message: preparationError || '모드와 필수 모드를 설치했습니다. 검사 결과를 확인하고 참가자에게 배포하세요.' };
  }

  async checkAll() {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      for (const id of await fs.readdir(this.publisher.root).catch(() => [])) {
        if (this.closed) break;
        if (!/^[a-f0-9]{32}$/.test(id) || !await fs.pathExists(this.registryFile(id))) continue;
        try { await this.update(id, true); }
        catch (error) {
          await this.publisher.serial(id, async () => {
            const state = await this.readRegistry(id);
            state.error = error.isAxiosError ? '모드 업데이트에 연결할 수 없습니다.' : error.message;
            state.lastChecked = new Date().toISOString();
            await writeJsonAtomic(this.registryFile(id), state);
          }).catch(() => {});
          this.onError(Error('모드 자동 업데이트를 보류했습니다. 모드 관리 화면에서 상태를 확인하세요.'));
        }
      }
    } finally { this.checking = false; }
  }

  start() {
    this.startTimer = setTimeout(() => this.checkAll(), 30000); this.startTimer.unref?.();
    this.timer = setInterval(() => this.checkAll(), 30 * 60 * 1000); this.timer.unref?.();
  }

  close() { this.closed = true; clearTimeout(this.startTimer); clearInterval(this.timer); }
}

function pathKey(file) { return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file); }

module.exports = ModCatalog;
