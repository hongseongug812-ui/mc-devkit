'use strict';

const { spawn, execSync } = require('child_process');
const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const axios = require('axios');

const PAPER_API    = 'https://api.papermc.io/v2/projects/paper';
const ADOPTIUM_API = 'https://api.adoptium.net/v3/binary/latest/21/ga';
const JRE_DIR      = path.join(os.homedir(), '.mc-devkit', 'jre');

class ServerManager {
  constructor(config, onLog, onCrash) {
    this.config    = config;
    this.onLog     = onLog;
    this.onCrash   = onCrash || (() => {});
    this.process   = null;
    this.status    = 'stopped';
    this._javaPath = null;
    this._stopping = false;   // 정상 종료 여부 추적
  }

  // ── Java 자동 확보 (번들 → 시스템 → 캐시 → Adoptium 다운로드) ──────────────
  async _ensureJava() {
    if (this._javaPath) return this._javaPath;

    // 0. 인스톨러에 번들된 JRE (배포 빌드 전용)
    if (process.env.DEVKIT_RESOURCES) {
      const bundled = path.join(process.env.DEVKIT_RESOURCES, 'jre', 'bin',
        process.platform === 'win32' ? 'java.exe' : 'java');
      if (await fs.pathExists(bundled)) {
        this.onLog('[DevKit] 번들 JRE 21 사용');
        this._javaPath = bundled;
        return bundled;
      }
    }

    // 1. 시스템 Java 확인
    try {
      const ver = execSync('java -version 2>&1', { encoding: 'utf8' }).split('\n')[0];
      this.onLog(`[DevKit] Java 발견: ${ver}`);
      this._javaPath = 'java';
      return 'java';
    } catch {}

    // 2. 이전에 내려받은 JRE 재사용
    const javaExe = path.join(JRE_DIR, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (await fs.pathExists(javaExe)) {
      this.onLog('[DevKit] 설치된 JRE 21 사용');
      this._javaPath = javaExe;
      return javaExe;
    }

    // 3. Adoptium JRE 21 자동 다운로드
    this.onLog('[DevKit] Java 미설치 — Adoptium JRE 21 자동 다운로드 시작...');
    this.onLog('[DevKit] (약 50 MB, 한 번만 다운로드됩니다)');

    const platformMap = { win32: 'windows', darwin: 'mac', linux: 'linux' };
    const archMap     = { x64: 'x64', arm64: 'aarch64' };
    const plat = platformMap[process.platform] || 'linux';
    const arch = archMap[process.arch] || 'x64';

    const url = `${ADOPTIUM_API}/${plat}/${arch}/jre/hotspot/normal/eclipse`;

    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 10,
      onDownloadProgress: (() => {
        let lastPct = 0;
        return (e) => {
          if (!e.total) return;
          const pct = Math.floor(e.loaded / e.total * 100);
          if (pct >= lastPct + 20) {          // 20% 단위로 로그
            lastPct = pct;
            this.onLog(`[DevKit] 다운로드 ${pct}%...`);
          }
        };
      })(),
    });

    const ext     = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const tmpFile = path.join(os.tmpdir(), `adoptium-jre21.${ext}`);
    await fs.writeFile(tmpFile, resp.data);
    this.onLog('[DevKit] 다운로드 완료. 압축 해제 중...');

    await fs.ensureDir(JRE_DIR);
    execSync(`tar -xf "${tmpFile}" -C "${JRE_DIR}" --strip-components=1`);
    await fs.remove(tmpFile);

    if (!await fs.pathExists(javaExe)) {
      throw new Error('JRE 압축 해제 실패. 수동으로 Java를 설치해주세요.');
    }

    // Unix 실행 권한
    if (process.platform !== 'win32') fs.chmodSync(javaExe, 0o755);

    this.onLog('[DevKit] Java JRE 21 설치 완료 ✓');
    this._javaPath = javaExe;
    return javaExe;
  }

  // ── Paper 최신 빌드 번호 조회 ──────────────────────────────────────────────
  async _getLatestBuild(version) {
    const { data } = await axios.get(`${PAPER_API}/versions/${version}/builds`);
    const all    = data.builds ?? [];
    const stable = all.filter(b => b.channel === 'default');
    const latest = (stable.length ? stable : all).at(-1);
    if (!latest) throw new Error(`Paper ${version} 빌드를 찾을 수 없습니다.`);
    return latest.build;
  }

  // ── PlugManX 자동 설치 ──────────────────────────────────────────────────────
  async _ensurePlugManX() {
    const pluginsDir = path.join(this.config.serverDir, 'plugins');
    await fs.ensureDir(pluginsDir);

    const files = await fs.readdir(pluginsDir);
    if (files.some(f => /plugman/i.test(f) && f.endsWith('.jar'))) return;

    this.onLog('[DevKit] PlugManX 다운로드 중...');
    try {
      const { data: releases } = await axios.get(
        'https://api.github.com/repos/TheAbsolutionism/PlugManX/releases',
        { headers: { 'User-Agent': 'mc-devkit' } }
      );
      const rel   = releases[0];
      if (!rel) throw new Error('릴리즈 없음');
      const asset = rel.assets.find(a => a.name.endsWith('.jar'));
      if (!asset) throw new Error('jar 파일을 찾을 수 없습니다');

      const resp = await axios.get(asset.browser_download_url, {
        responseType: 'arraybuffer', maxRedirects: 10,
      });
      await fs.writeFile(path.join(pluginsDir, asset.name), resp.data);
      this.onLog(`[DevKit] PlugManX 설치 완료 ✓ (${asset.name})`);
    } catch (e) {
      this.onLog(`[DevKit] PlugManX 자동 설치 실패 (수동 설치 권장): ${e.message}`);
    }
  }

  // ── Paper jar 확보 (번들 → 다운로드) ──────────────────────────────────────
  async _ensurePaper() {
    const jarPath = path.join(this.config.serverDir, 'paper.jar');
    if (await fs.pathExists(jarPath)) return;

    // 번들 Paper 확인 (배포 빌드 전용, 버전이 일치할 때만)
    if (process.env.DEVKIT_RESOURCES) {
      const bundled = path.join(process.env.DEVKIT_RESOURCES, 'bundled',
        `paper-${this.config.version}.jar`);
      if (await fs.pathExists(bundled)) {
        this.onLog(`[DevKit] 번들 Paper ${this.config.version} 사용`);
        await fs.ensureDir(this.config.serverDir);
        await fs.copy(bundled, jarPath);
        return;
      }
    }

    this.onLog(`[DevKit] Paper ${this.config.version} 다운로드 중...`);
    const build   = await this._getLatestBuild(this.config.version);
    const jarName = `paper-${this.config.version}-${build}.jar`;
    const url     = `${PAPER_API}/versions/${this.config.version}/builds/${build}/downloads/${jarName}`;

    await fs.ensureDir(this.config.serverDir);
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(jarPath, resp.data);
    this.onLog(`[DevKit] Paper 다운로드 완료 ✓`);
  }

  // ── server.properties 자동 설정 ────────────────────────────────────────────
  async _writeServerProps() {
    const propsPath = path.join(this.config.serverDir, 'server.properties');
    let props = await fs.pathExists(propsPath)
      ? await fs.readFile(propsPath, 'utf8')
      : '';

    const set = (key, val) => {
      const re = new RegExp(`^${key}=.*`, 'm');
      return re.test(props) ? props.replace(re, `${key}=${val}`) : props + `\n${key}=${val}`;
    };

    props = set('enable-rcon',   'true');
    props = set('rcon.port',     '25575');
    props = set('rcon.password', this.config.rconPassword);
    props = set('online-mode',   'false');
    await fs.writeFile(propsPath, props);
  }

  // ── 서버 시작 (완전 자동) ──────────────────────────────────────────────────
  async start() {
    if (this.status !== 'stopped') throw new Error('서버가 이미 실행 중입니다.');

    this.status    = 'starting';
    this._stopping = false;

    try {
      const javaPath = await this._ensureJava();  // Java 자동 확보
      await this._ensurePaper();                  // Paper 자동 다운로드
      await this._ensurePlugManX();               // PlugManX 자동 설치
      await fs.writeFile(path.join(this.config.serverDir, 'eula.txt'), 'eula=true\n');
      await this._writeServerProps();

      this.onLog('[DevKit] 서버 시작 중...');

      this.process = spawn(
        javaPath,
        [`-Xmx${this.config.memory}`, `-Xms${this.config.memory}`, '-jar', 'paper.jar', '--nogui'],
        { cwd: this.config.serverDir, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      this.status = 'stopped';
      this.onLog(`[DevKit] 시작 실패: ${err.message}`);
      throw err;
    }

    this.process.on('error', (err) => {
      this.status = 'stopped';
      this.process = null;
      this.onLog(`[DevKit] 프로세스 오류: ${err.message}`);
    });

    this.process.stdout.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line => {
        this.onLog(line);
        if (line.includes('Done') && line.includes('For help')) {
          this.status = 'running';
          this.onLog('[DevKit] 서버 준비 완료 ✓');
        }
      });
    });

    this.process.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(l => this.onLog(l));
    });

    this.process.on('exit', (code) => {
      const crashed = !this._stopping && this.status !== 'stopping' && code !== 0 && code !== null;
      this.status  = 'stopped';
      this.process = null;
      this.onLog(`[DevKit] 서버 종료됨 (exit code: ${code})`);

      if (crashed) {
        this.onLog('[DevKit] ⚠ 비정상 종료 감지 — 10초 후 자동 재시작...');
        this.onCrash();
        setTimeout(() => {
          this.start().catch(e => this.onLog(`[DevKit] 자동 재시작 실패: ${e.message}`));
        }, 10000);
      }
    });
  }

  // ── stdin 직접 입력 ──────────────────────────────────────────────────────────
  sendInput(line) {
    if (!this.process) throw new Error('서버가 실행 중이 아닙니다.');
    this.process.stdin.write(line + '\n');
  }

  // ── 서버 중지 ───────────────────────────────────────────────────────────────
  async stop() {
    if (!this.process) throw new Error('실행 중인 서버가 없습니다.');
    this._stopping = true;
    this.status = 'stopping';
    this.onLog('[DevKit] 서버 중지 중...');
    this.process.stdin.write('stop\n');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => { this.process?.kill('SIGKILL'); resolve(); }, 10000);
      this.process.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }

  // ── 서버 재시작 ─────────────────────────────────────────────────────────────
  async restart() {
    this.onLog('[DevKit] 서버 재시작 중...');
    await this.stop();
    await new Promise(r => setTimeout(r, 2000));
    await this.start();
  }

  getStatus() { return this.status; }
}

module.exports = ServerManager;
