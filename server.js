'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http   = require('http');
const path   = require('path');
const os     = require('os');
const fs     = require('fs-extra');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const axios = require('axios');

const ServerManager  = require('./core/server-manager');
const RconClient     = require('./core/rcon-client');
const BuildWatcher   = require('./core/build-watcher');
const TunnelManager  = require('./core/tunnel-manager');
const TeamManager    = require('./core/team-manager');
const PlayitManager  = require('./core/playit-manager');

// ── 설정 자동 저장/로드 ──────────────────────────────────────────────────
const CONFIG_FILE = path.join(os.homedir(), '.mc-devkit', 'config.json');

function loadSavedConfig() {
  try { return fs.readJsonSync(CONFIG_FILE); } catch { return {}; }
}

function saveConfig() {
  try {
    fs.ensureDirSync(path.dirname(CONFIG_FILE));
    const { rconPassword: _, ...toSave } = CONFIG;
    fs.writeJsonSync(CONFIG_FILE, toSave, { spaces: 2 });
  } catch {}
}

const _saved = loadSavedConfig();

const CONFIG = {
  serverDir:    _saved.serverDir    || process.env.SERVER_DIR    || './minecraft-server',
  projectDir:   _saved.projectDir   || process.env.PROJECT_DIR   || process.cwd(),
  pluginName:   _saved.pluginName   || process.env.PLUGIN_NAME   || 'MyPlugin',
  paperVersion: _saved.paperVersion || process.env.PAPER_VERSION || '1.21.4',
  memory:       _saved.memory       || process.env.MEMORY        || '2G',
  serverType:   _saved.serverType   || 'paper',
  rconPassword: process.env.RCON_PASSWORD || 'devkit_' + Math.random().toString(36).slice(2),
  buildCmd:     _saved.buildCmd     || process.env.BUILD_CMD     || null,
  playitSecret: _saved.playitSecret || process.env.PLAYIT_SECRET || null,
};

// 서버 타입별 독립 폴더 계산 (server-manager와 동일 로직)
function activeServerDir() {
  return path.join(CONFIG.serverDir, CONFIG.serverType || 'paper');
}

// ── 상태 ──────────────────────────────────────────────────────────────────
const state = { serverStatus: 'stopped', tunnelUrl: null, mcAddress: null, players: [], tps: null };

// ── 모듈 인스턴스 ─────────────────────────────────────────────────────────
const rcon = new RconClient('127.0.0.1', 25575, CONFIG.rconPassword);

const serverManager = new ServerManager(
  { serverDir: CONFIG.serverDir, version: CONFIG.paperVersion, memory: CONFIG.memory, serverType: CONFIG.serverType, rconPassword: CONFIG.rconPassword },
  (line) => {
    teamManager?.broadcastLog(line);

    // 플레이어 접속/퇴장 파싱
    const joined = line.match(/(\w+) joined the game/);
    if (joined && !state.players.includes(joined[1])) {
      state.players.push(joined[1]);
      teamManager?.broadcast({ type: 'PLAYERS_UPDATE', players: state.players });
    }
    const left = line.match(/(\w+) (?:left the game|lost connection)/);
    if (left) {
      state.players = state.players.filter(p => p !== left[1]);
      teamManager?.broadcast({ type: 'PLAYERS_UPDATE', players: state.players });
    }

    // TPS 파싱 (Paper: "TPS from last 1m, 5m, 15m: 19.97, 19.98, 19.99")
    const tpsMatch = line.match(/TPS from last 1m,\s*5m,\s*15m:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
    if (tpsMatch) {
      state.tps = { m1: tpsMatch[1], m5: tpsMatch[2], m15: tpsMatch[3] };
      teamManager?.broadcast({ type: 'TPS_UPDATE', tps: state.tps });
    }

    // 서버 상태 변화 감지
    const s = serverManager.getStatus();
    if (s !== state.serverStatus) {
      state.serverStatus = s;

      if (s === 'stopped') {
        state.players = [];
        // 서버 종료 시 ngrok도 중지 + 주소 초기화
        if (ngrokManager.isRunning()) ngrokManager.stop();
        state.mcAddress = null;
        teamManager?.broadcast({ type: 'MC_ADDRESS', address: null });
      }

      teamManager?.broadcastStatus(s, state.tunnelUrl);
      teamManager?.broadcast({ type: 'PLAYERS_UPDATE', players: state.players });

      if (s === 'running' && !ngrokManager.isRunning()) {
        ngrokManager.start().catch(e =>
          teamManager?.broadcastLog(`[DevKit] ngrok 자동 시작 실패: ${e.message}`)
        );
      }
    }
  },
  // 크래시 콜백
  () => { teamManager?.broadcast({ type: 'SERVER_CRASH' }); }
);

const buildWatcher = new BuildWatcher(
  { projectDir: CONFIG.projectDir, serverDir: CONFIG.serverDir, pluginName: CONFIG.pluginName, buildCmd: CONFIG.buildCmd },
  rcon,
  (line) => { teamManager?.broadcastLog(line); }
);

const tunnelManager = new TunnelManager(
  null,
  (line) => { teamManager?.broadcastLog(line); },
  (url)  => { state.tunnelUrl = url; teamManager?.broadcastStatus(state.serverStatus, url); }
);

const ngrokManager = new PlayitManager(
  (line) => { teamManager?.broadcastLog(line); },
  (url)  => { teamManager?.broadcast({ type: 'PLAYIT_CLAIM', url }); },
  (addr) => { state.mcAddress = addr; teamManager?.broadcast({ type: 'MC_ADDRESS', address: addr }); }
);

let teamManager = null;

// REST API 권한 체크 미들웨어
function requirePerm(perm) {
  return (req, res, next) => {
    const token = req.headers['x-devkit-token'];
    if (!token || !teamManager) return res.status(401).json({ error: '인증 필요' });
    const client = teamManager.clients.get(token);
    if (!client) return res.status(401).json({ error: '유효하지 않은 토큰' });
    const perms = teamManager.roles[client.role] || [];
    if (!perms.includes(perm)) return res.status(403).json({ error: `권한 없음: ${perm}` });
    next();
  };
}

// ── 서버 시작 (main.js에서 호출) ─────────────────────────────────────────
function startServer(port) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '512mb' }));
    app.use(express.static(path.join(__dirname, 'client')));

    const httpServer = http.createServer(app);
    const wss        = new WebSocketServer({ server: httpServer });

    tunnelManager.port = port;
    teamManager = new TeamManager(wss, {
      onStart:   () => serverManager.start(),
      onStop:    () => serverManager.stop(),
      onRestart: () => serverManager.restart(),
      onBuild:   () => buildWatcher.triggerBuild(),
      onReload: () => {
        if (serverManager.getStatus() !== 'running')
          throw new Error('서버가 실행 중이 아닙니다.');
        return rcon.sendSafe(`plugman reload ${CONFIG.pluginName}`);
      },
      onCommand: (cmd) => {
        if (serverManager.getStatus() !== 'running')
          throw new Error('서버가 실행 중이 아닙니다.');
        return rcon.sendSafe(cmd.replace(/^\//, ''));
      },
      onStdin: (input) => {
        serverManager.sendInput(input);
      },
    });

    // ── REST API ────────────────────────────────────────────────────────
    app.get('/api/status', (_, res) => res.json({
      server:     serverManager.getStatus(),
      tunnel:     tunnelManager.getUrl(),
      plugin:     CONFIG.pluginName,
      ownerToken: teamManager.getOwnerToken(),
      mcAddress:  state.mcAddress,
      players:    state.players,
    }));

    app.post('/api/server/start',   async (_, res) => safeRun(res, () => serverManager.start()));
    app.post('/api/server/stop',    async (_, res) => safeRun(res, () => serverManager.stop()));
    app.post('/api/server/restart', async (_, res) => safeRun(res, () => serverManager.restart()));
    app.post('/api/build',          async (_, res) => safeRun(res, () => buildWatcher.triggerBuild()));
    app.post('/api/tunnel/start',   async (_, res) => safeRun(res, () => tunnelManager.start()));
    app.post('/api/tunnel/stop',    (_, res)        => { tunnelManager.stop(); res.json({ ok: true }); });

    app.post('/api/config', (req, res) => {
      const { projectDir, pluginName, serverDir, memory, paperVersion, buildCmd, serverType } = req.body;
      if (projectDir)   { CONFIG.projectDir  = projectDir;  buildWatcher.config.projectDir = projectDir; }
      if (pluginName)   { CONFIG.pluginName   = pluginName;  buildWatcher.config.pluginName = pluginName; }
      if (serverDir)    { CONFIG.serverDir    = serverDir;   serverManager.config.serverDir = serverDir; }
      if (memory)       { CONFIG.memory       = memory;      serverManager.config.memory    = memory; }
      if (paperVersion) { CONFIG.paperVersion = paperVersion; serverManager.config.version  = paperVersion; }
      if (buildCmd !== undefined) { CONFIG.buildCmd = buildCmd; buildWatcher.config.buildCmd = buildCmd || null; }
      if (serverType) { CONFIG.serverType = serverType; serverManager.config.serverType = serverType; }
      saveConfig();
      res.json({ ok: true, config: CONFIG });
    });
    app.get('/api/config', (_, res) => res.json(CONFIG));

    // ── 서버 프로필 ───────────────────────────────────────────────────────────
    const PROFILES_FILE = path.join(os.homedir(), '.mc-devkit', 'profiles.json');
    const loadProfiles  = () => { try { return fs.readJsonSync(PROFILES_FILE); } catch { return {}; } };
    const saveProfiles  = (p) => { fs.ensureDirSync(path.dirname(PROFILES_FILE)); fs.writeJsonSync(PROFILES_FILE, p, { spaces: 2 }); };

    app.get('/api/profiles', (_, res) => res.json(loadProfiles()));

    app.post('/api/profiles', (req, res) => {
      const { name, image } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: '프로필 이름을 입력하세요.' });
      const profiles = loadProfiles();
      profiles[name] = {
        serverType:   CONFIG.serverType,
        paperVersion: CONFIG.paperVersion,
        memory:       CONFIG.memory,
        serverDir:    CONFIG.serverDir,
        projectDir:   CONFIG.projectDir,
        pluginName:   CONFIG.pluginName,
        buildCmd:     CONFIG.buildCmd,
        image:        image !== undefined ? image : (profiles[name]?.image || null),
      };
      saveProfiles(profiles);
      res.json({ ok: true });
    });

    app.delete('/api/profiles/:name', (req, res) => {
      const profiles = loadProfiles();
      delete profiles[decodeURIComponent(req.params.name)];
      saveProfiles(profiles);
      res.json({ ok: true });
    });

    app.post('/api/profiles/:name/load', (req, res) => {
      const profiles = loadProfiles();
      const p = profiles[decodeURIComponent(req.params.name)];
      if (!p) return res.status(404).json({ error: '프로필을 찾을 수 없습니다.' });
      if (p.serverType)   { CONFIG.serverType   = p.serverType;   serverManager.config.serverType = p.serverType; }
      if (p.paperVersion) { CONFIG.paperVersion = p.paperVersion; serverManager.config.version    = p.paperVersion; }
      if (p.memory)       { CONFIG.memory       = p.memory;       serverManager.config.memory     = p.memory; }
      if (p.serverDir)    { CONFIG.serverDir    = p.serverDir;    serverManager.config.serverDir  = p.serverDir; }
      if (p.projectDir)   { CONFIG.projectDir   = p.projectDir;   buildWatcher.config.projectDir  = p.projectDir; }
      if (p.pluginName)   { CONFIG.pluginName   = p.pluginName;   buildWatcher.config.pluginName  = p.pluginName; }
      if (p.buildCmd !== undefined) { CONFIG.buildCmd = p.buildCmd; buildWatcher.config.buildCmd  = p.buildCmd || null; }
      saveConfig();
      res.json({ ok: true, config: CONFIG });
    });

    app.get('/api/paper-versions', async (_, res) => {
      try {
        const { data } = await axios.get('https://api.purpurmc.org/v2/purpur', { timeout: 8000 });
        res.json(([...(data.versions ?? [])]).reverse());
      } catch { res.json([]); }
    });

    app.get('/api/fabric-versions', async (_, res) => {
      try {
        const { data } = await axios.get('https://meta.fabricmc.net/v2/versions/game', { timeout: 8000 });
        res.json(data.filter(v => v.stable).map(v => v.version));
      } catch { res.json([]); }
    });

    app.get('/api/arclight-versions', async (_, res) => {
      try {
        const { data: releases } = await axios.get(
          'https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=50',
          { headers: { 'User-Agent': 'mc-devkit' }, timeout: 10000 }
        );
        const versionSet = new Set();
        for (const rel of releases) {
          if (rel.prerelease || rel.tag_name.includes('SNAPSHOT')) continue;
          for (const asset of rel.assets) {
            const m = asset.name.match(/arclight-(?:forge|neoforge|fabric)-([\d.]+)-/);
            if (m) versionSet.add(m[1]);
          }
        }
        const sorted = [...versionSet].sort((a, b) => {
          const av = a.split('.').map(Number), bv = b.split('.').map(Number);
          for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            const d = (bv[i] || 0) - (av[i] || 0);
            if (d !== 0) return d;
          }
          return 0;
        });
        res.json(sorted);
      } catch { res.json([]); }
    });

    app.get('/api/cardboard-versions', async (_, res) => {
      try {
        const { data } = await axios.get('https://api.modrinth.com/v2/project/cardboard', {
          headers: { 'User-Agent': 'mc-devkit' }, timeout: 8000,
        });
        const versions = (data.game_versions || []).filter(v => /^\d+\.\d+(\.\d+)?$/.test(v));
        versions.sort((a, b) => {
          const av = a.split('.').map(Number), bv = b.split('.').map(Number);
          for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            const d = (bv[i] || 0) - (av[i] || 0);
            if (d !== 0) return d;
          }
          return 0;
        });
        res.json(versions);
      } catch { res.json([]); }
    });

    // ── 권한 API ──────────────────────────────────────────────────────────
    app.get('/api/permissions', (_, res) => res.json(teamManager.getPermissions()));
    app.post('/api/permissions', (req, res) => { teamManager.setPermissions(req.body); res.json({ ok: true }); });

    // ── playit 터널 ───────────────────────────────────────────────────────
    // secret key 적용
    if (CONFIG.playitSecret) ngrokManager.setSecretKey(CONFIG.playitSecret);

    app.get('/api/ngrok/status', (_, res) => res.json({
      running:  ngrokManager.isRunning(),
      address:  ngrokManager.getAddress(),
      claimUrl: ngrokManager.getClaimUrl(),
    }));
    app.post('/api/ngrok/start', async (_, res) => safeRun(res, () => ngrokManager.start()));
    app.post('/api/ngrok/stop',  (_, res) => { ngrokManager.stop(); res.json({ ok: true }); });

    app.post('/api/playit/secret', (req, res) => {
      const { secret } = req.body;
      CONFIG.playitSecret = secret || null;
      ngrokManager.setSecretKey(CONFIG.playitSecret);
      fs.ensureDir(path.dirname(CONFIG_FILE))
        .then(() => fs.writeJson(CONFIG_FILE, CONFIG, { spaces: 2 }));
      res.json({ ok: true });
    });

    // ── MC 서버 주소 ──────────────────────────────────────────────────────
    app.get('/api/mc-address', (_, res) => res.json({ address: state.mcAddress }));
    app.post('/api/mc-address', (req, res) => {
      state.mcAddress = req.body.address || null;
      teamManager?.broadcast({ type: 'MC_ADDRESS', address: state.mcAddress });
      res.json({ ok: true });
    });

    // ── 플레이어 목록 ──────────────────────────────────────────────────────
    app.get('/api/players', async (_, res) => {
      if (serverManager.getStatus() !== 'running') return res.json([]);
      try {
        const result = await rcon.sendSafe('list');
        // "There are N of a max of M players online: p1, p2"
        const m = result?.match(/players online:\s*(.*)/i);
        if (m && m[1].trim()) {
          state.players = m[1].split(',').map(p => p.trim()).filter(Boolean);
        } else {
          state.players = [];
        }
      } catch { state.players = []; }
      res.json(state.players);
    });

    // ── 세계 백업 ──────────────────────────────────────────────────────────
    app.post('/api/backup', async (_, res) => {
      try {
        teamManager?.broadcastLog('[DevKit] 백업 시작...');

        // 서버 실행 중이면 먼저 저장
        if (serverManager.getStatus() === 'running') {
          await rcon.sendSafe('save-all');
          await new Promise(r => setTimeout(r, 2000));
        }

        const backupDir = path.join(os.homedir(), '.mc-devkit', 'backups');
        await fs.ensureDir(backupDir);

        const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const out = path.join(backupDir, `world-${ts}.tar.gz`);

        const serverDirAbs = path.resolve(CONFIG.serverDir);
        const worlds = ['world','world_nether','world_the_end']
          .filter(w => fs.pathExistsSync(path.join(serverDirAbs, w)));

        if (!worlds.length) throw new Error('월드 폴더를 찾을 수 없습니다');

        const outZip = out.replace(/\.tar\.gz$/, '.zip');
        let backupFile = out;

        if (process.platform === 'win32') {
          // Windows: robocopy로 임시 복사 후 zip (잠긴 파일 우회)
          const tmpDir = path.join(os.tmpdir(), `mcbk-${Date.now()}`);
          try {
            await fs.ensureDir(tmpDir);
            for (const w of worlds) {
              const src = path.join(serverDirAbs, w);
              const dst = path.join(tmpDir, w);
              await execAsync(
                `robocopy "${src}" "${dst}" /E /COPY:DAT /NFL /NDL /NJH /NJS /NC /NS /NP /XF session.lock`,
                { timeout: 60000 }
              ).catch(e => { if ((e.code || 0) > 7) throw e; }); // 0-7 = 정상
            }
            await execAsync(
              `powershell -NoProfile -Command "Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${outZip}' -Force"`,
              { timeout: 120000 }
            );
            backupFile = outZip;
          } finally {
            await fs.remove(tmpDir).catch(() => {});
          }
        } else {
          await execAsync(
            `tar -czf "${out}" -C "${serverDirAbs}" ${worlds.join(' ')}`,
            { timeout: 120000 }
          );
        }

        const size = (await fs.stat(backupFile)).size;
        teamManager?.broadcastLog(`[DevKit] 백업 완료 ✓ (${(size/1024/1024).toFixed(1)}MB) → ${backupFile}`);
        res.json({ ok: true, file: backupFile, size });
      } catch (e) {
        teamManager?.broadcastLog(`[DevKit] 백업 실패: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    // ── 모드 관리 (Fabric 전용 폴더) ─────────────────────────────────────────
    app.get('/api/mods', async (_, res) => {
      const dir = path.join(activeServerDir(), 'mods');
      try {
        await fs.ensureDir(dir);
        const files = await fs.readdir(dir);
        const list  = await Promise.all(
          files.filter(f => f.endsWith('.jar')).map(async name => {
            const stat = await fs.stat(path.join(dir, name));
            return { name, size: stat.size };
          })
        );
        res.json(list);
      } catch { res.json([]); }
    });

    app.post('/api/mods/upload', requirePerm('upload'), async (req, res) => {
      try {
        const { name, data } = req.body;
        if (!name?.endsWith('.jar')) return res.status(400).json({ error: 'jar 파일만 가능합니다.' });
        const dir = path.join(activeServerDir(), 'mods');
        await fs.ensureDir(dir);
        const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
        await fs.writeFile(path.join(dir, path.basename(name)), buf);
        teamManager?.broadcastLog(`[DevKit] 모드 업로드: ${name}`);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/mods/:name', requirePerm('upload'), async (req, res) => {
      try {
        const safe = path.basename(req.params.name);
        await fs.remove(path.join(activeServerDir(), 'mods', safe));
        teamManager?.broadcastLog(`[DevKit] 모드 삭제: ${safe}`);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── 월드 관리 ─────────────────────────────────────────────────────────────
    app.delete('/api/world', requirePerm('world'), async (_, res) => {
      if (serverManager.getStatus() !== 'stopped')
        return res.status(400).json({ error: '서버를 먼저 중지해주세요.' });
      const serverDirAbs = path.resolve(activeServerDir());
      const worlds = ['world', 'world_nether', 'world_the_end'];
      for (const w of worlds) await fs.remove(path.join(serverDirAbs, w)).catch(() => {});
      teamManager?.broadcastLog('[DevKit] 월드 삭제 완료 ✓');
      res.json({ ok: true });
    });

    app.post('/api/world/upload', requirePerm('world'), async (req, res) => {
      if (serverManager.getStatus() !== 'stopped')
        return res.status(400).json({ error: '서버를 먼저 중지해주세요.' });
      try {
        const { name, data } = req.body;
        if (!name?.match(/\.(zip)$/i)) return res.status(400).json({ error: '.zip 파일만 가능합니다.' });
        const serverDirAbs = path.resolve(activeServerDir());
        const tmpZip = path.join(os.tmpdir(), `world-upload-${Date.now()}.zip`);
        const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
        await fs.writeFile(tmpZip, buf);

        for (const w of ['world', 'world_nether', 'world_the_end'])
          await fs.remove(path.join(serverDirAbs, w)).catch(() => {});

        const tmpExtract = path.join(os.tmpdir(), `world-extract-${Date.now()}`);
        await fs.ensureDir(tmpExtract);
        try {
          await execAsync(
            `powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force"`,
            { timeout: 120000 }
          );

          const worldNames = ['world', 'world_nether', 'world_the_end'];

          // level.dat 위치로 월드 루트 탐색 (최대 2단계 깊이)
          const findWorldBase = async (dir, depth = 0) => {
            const entries = await fs.readdir(dir);
            if (entries.includes('level.dat')) return dir;
            if (depth >= 2) return null;
            for (const entry of entries) {
              const sub = path.join(dir, entry);
              if ((await fs.stat(sub)).isDirectory()) {
                const found = await findWorldBase(sub, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };

          const detectedWorldDir = await findWorldBase(tmpExtract);
          if (!detectedWorldDir) throw new Error('zip에서 월드 폴더(level.dat)를 찾을 수 없습니다. world 폴더를 포함한 zip인지 확인하세요.');

          // 월드 루트가 직접 tmpExtract인지, 아니면 상위 폴더(world_nether 등 포함)인지 판단
          const parentDir = path.dirname(detectedWorldDir);
          const worldFolderName = path.basename(detectedWorldDir);

          await fs.ensureDir(serverDirAbs);
          let moved = 0;
          if (worldFolderName === 'world' || !worldNames.includes(worldFolderName)) {
            // detectedWorldDir 자체가 world 폴더거나, 이름이 다른 단일 월드 폴더
            const dest = path.join(serverDirAbs, 'world');
            await fs.move(detectedWorldDir, dest, { overwrite: true });
            await fs.remove(path.join(dest, 'session.lock')).catch(() => {});
            moved++;
            // 형제 폴더에 world_nether, world_the_end가 있으면 함께 이동
            for (const w of ['world_nether', 'world_the_end']) {
              const sibling = path.join(parentDir, w);
              if (await fs.pathExists(sibling)) {
                await fs.move(sibling, path.join(serverDirAbs, w), { overwrite: true });
                await fs.remove(path.join(serverDirAbs, w, 'session.lock')).catch(() => {});
                moved++;
              }
            }
          } else {
            // worldNames 중 하나의 이름을 가진 폴더 → 형제 폴더 전체 이동
            for (const w of worldNames) {
              const src = path.join(parentDir, w);
              if (await fs.pathExists(src)) {
                await fs.move(src, path.join(serverDirAbs, w), { overwrite: true });
                await fs.remove(path.join(serverDirAbs, w, 'session.lock')).catch(() => {});
                moved++;
              }
            }
          }
          teamManager?.broadcastLog(`[DevKit] 월드 폴더 ${moved}개 적용 완료`);
        } finally {
          await fs.remove(tmpExtract).catch(() => {});
          await fs.remove(tmpZip).catch(() => {});
        }
        teamManager?.broadcastLog(`[DevKit] 월드 업로드 완료 ✓ (${name})`);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/backups', async (_, res) => {
      const backupDir = path.join(os.homedir(), '.mc-devkit', 'backups');
      try {
        await fs.ensureDir(backupDir);
        const files = await fs.readdir(backupDir);
        const list  = await Promise.all(
          files.filter(f => f.endsWith('.tar.gz')).map(async name => {
            const stat = await fs.stat(path.join(backupDir, name));
            return { name, size: stat.size, date: stat.mtime };
          })
        );
        res.json(list.sort((a, b) => new Date(b.date) - new Date(a.date)));
      } catch { res.json([]); }
    });

    // ── 플러그인 관리 (Paper 전용 폴더) ──────────────────────────────────────
    app.get('/api/plugins', async (_, res) => {
      const dir = path.join(activeServerDir(), 'plugins');
      try {
        await fs.ensureDir(dir);
        const files = await fs.readdir(dir);
        const list  = await Promise.all(
          files.filter(f => f.endsWith('.jar')).map(async name => {
            const stat = await fs.stat(path.join(dir, name));
            return { name, size: stat.size };
          })
        );
        res.json(list);
      } catch { res.json([]); }
    });

    app.post('/api/plugins/upload', requirePerm('upload'), async (req, res) => {
      try {
        const { name, data } = req.body;
        if (!name?.endsWith('.jar')) return res.status(400).json({ error: 'jar 파일만 가능합니다.' });
        const safeName = path.basename(name);
        const dir = path.join(activeServerDir(), 'plugins');
        await fs.ensureDir(dir);
        const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
        await fs.writeFile(path.join(dir, safeName), buf);
        teamManager?.broadcastLog(`[DevKit] 플러그인 업로드: ${safeName}`);

        if (serverManager.getStatus() === 'running') {
          const pName = safeName.replace(/\.jar$/i, '').replace(/[-_][\d.]+$/, '');
          try {
            await rcon.sendSafe(`plugman load ${pName}`);
            teamManager?.broadcastLog(`[DevKit] 플러그인 로드 완료: ${pName} ✓`);
          } catch {
            try {
              await rcon.sendSafe(`plugman reload ${pName}`);
              teamManager?.broadcastLog(`[DevKit] 플러그인 리로드 완료: ${pName} ✓`);
            } catch (e2) {
              teamManager?.broadcastLog(`[DevKit] 자동 로드 실패 — 재시작 후 적용: ${e2.message}`);
            }
          }
        } else {
          teamManager?.broadcastLog(`[DevKit] 서버 시작 시 자동 로드됩니다: ${safeName}`);
        }
        res.json({ ok: true, filename: safeName });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/plugins/:name', requirePerm('upload'), async (req, res) => {
      try {
        const safe = path.basename(req.params.name);
        await fs.remove(path.join(activeServerDir(), 'plugins', safe));
        teamManager?.broadcastLog(`[DevKit] 플러그인 삭제: ${safe}`);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── server.properties ────────────────────────────────────────────────────
    function parseProperties(text) {
      const result = {};
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('!')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        result[t.slice(0, eq).trim()] = t.slice(eq + 1);
      }
      return result;
    }

    function stringifyProperties(updates, originalText) {
      const updated = new Set();
      const lines = originalText.split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('!')) return line;
        const eq = t.indexOf('=');
        if (eq === -1) return line;
        const key = t.slice(0, eq).trim();
        if (key in updates) { updated.add(key); return `${key}=${updates[key]}`; }
        return line;
      });
      for (const [key, val] of Object.entries(updates))
        if (!updated.has(key)) lines.push(`${key}=${val}`);
      return lines.join('\n');
    }

    app.get('/api/server-properties', async (_, res) => {
      const file = path.join(activeServerDir(), 'server.properties');
      try {
        const text = await fs.readFile(file, 'utf8');
        res.json({ ok: true, props: parseProperties(text) });
      } catch (e) {
        if (e.code === 'ENOENT') res.json({ ok: true, props: {} });
        else res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/server-properties', async (req, res) => {
      const file = path.join(activeServerDir(), 'server.properties');
      try {
        let original = '';
        try { original = await fs.readFile(file, 'utf8'); } catch {}
        await fs.writeFile(file, stringifyProperties(req.body, original), 'utf8');
        teamManager?.broadcastLog('[DevKit] server.properties 저장 완료 ✓ (재시작 후 적용)');
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 30초마다 TPS 조회 (main thread 간섭 최소화)
    setInterval(async () => {
      if (serverManager.getStatus() !== 'running') return;
      try { await rcon.sendSafe('tps'); } catch {}
    }, 30000);

    httpServer.listen(port, () => {
      console.log(`[MC DevKit] 서버 실행 중 → http://localhost:${port}`);
      buildWatcher.start();
      resolve(httpServer);
    });
  });
}

function safeRun(res, fn) {
  fn().then(() => res.json({ ok: true }))
      .catch(e  => res.status(500).json({ error: e.message }));
}

function getState() { return state; }
module.exports = { startServer, getState };
