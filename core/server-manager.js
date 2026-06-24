'use strict';

const { spawn, execSync } = require('child_process');
const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const axios = require('axios');

const PAPER_API    = 'https://api.papermc.io/v2/projects/paper';
const ADOPTIUM_API = 'https://api.adoptium.net/v3/binary/latest/21/ga';
const FABRIC_META  = 'https://meta.fabricmc.net/v2/versions/installer';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer';
const JRE_DIR      = path.join(os.homedir(), '.mc-devkit', 'jre');

class ServerManager {
  constructor(config, onLog, onCrash) {
    this.config    = config;
    this.onLog     = onLog;
    this.onCrash   = onCrash || (() => {});
    this.process    = null;
    this.status     = 'stopped';
    this._javaPath  = null;
    this._stopping  = false;
    this._crashTimes = [];   // 크래시 루프 감지용
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
    const jarPath  = path.join(this.config.serverDir, 'paper.jar');
    const verFile  = path.join(this.config.serverDir, '.paper-version');
    const savedVer = await fs.pathExists(verFile) ? (await fs.readFile(verFile, 'utf8')).trim() : null;

    // 버전이 바뀌었으면 기존 jar 삭제 후 재다운로드
    if (savedVer !== this.config.version && await fs.pathExists(jarPath)) {
      this.onLog(`[DevKit] Paper 버전 변경 (${savedVer} → ${this.config.version}), 재다운로드 중...`);
      await fs.remove(jarPath);
    }

    if (await fs.pathExists(jarPath)) return;

    // 번들 Paper 확인 (배포 빌드 전용, 버전이 일치할 때만)
    if (process.env.DEVKIT_RESOURCES) {
      const bundled = path.join(process.env.DEVKIT_RESOURCES, 'bundled',
        `paper-${this.config.version}.jar`);
      if (await fs.pathExists(bundled)) {
        this.onLog(`[DevKit] 번들 Paper ${this.config.version} 사용`);
        await fs.ensureDir(this.config.serverDir);
        await fs.copy(bundled, jarPath);
        await fs.writeFile(verFile, this.config.version);
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
    await fs.writeFile(verFile, this.config.version);
    this.onLog(`[DevKit] Paper 다운로드 완료 ✓`);
  }

  // ── Fabric 서버 설치 ────────────────────────────────────────────────────────
  async _ensureFabric() {
    const launchJar = path.join(this.config.serverDir, 'fabric-server-launch.jar');
    const verFile   = path.join(this.config.serverDir, '.fabric-version');
    const savedVer  = await fs.pathExists(verFile) ? (await fs.readFile(verFile, 'utf8')).trim() : null;

    // 버전이 바뀌었으면 기존 jar 삭제 후 재설치
    if (savedVer !== this.config.version && await fs.pathExists(launchJar)) {
      this.onLog(`[DevKit] Fabric 버전 변경 (${savedVer} → ${this.config.version}), 재설치 중...`);
      await fs.remove(launchJar);
    }

    if (await fs.pathExists(launchJar)) return;

    await fs.ensureDir(this.config.serverDir);

    // 최신 인스톨러 버전 조회 후 다운로드
    this.onLog('[DevKit] Fabric 인스톨러 다운로드 중...');
    const { data: versions } = await axios.get(FABRIC_META);
    const ver = versions[0].version;
    const installerUrl = `${FABRIC_MAVEN}/${ver}/fabric-installer-${ver}.jar`;
    const instPath = path.join(this.config.serverDir, 'fabric-installer.jar');
    const resp = await axios.get(installerUrl, { responseType: 'arraybuffer', maxRedirects: 10 });
    await fs.writeFile(instPath, resp.data);

    // 인스톨러 실행 → fabric-server-launch.jar 생성
    this.onLog(`[DevKit] Fabric 서버 설치 중 (MC ${this.config.version})...`);
    const javaPath = await this._ensureJava();
    await new Promise((resolve, reject) => {
      const proc = spawn(javaPath, [
        '-jar', 'fabric-installer.jar',
        'server', '-mcversion', this.config.version, '-downloadMinecraft',
      ], { cwd: this.config.serverDir, stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => this.onLog(`[Fabric] ${l}`)));
      proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => this.onLog(`[Fabric] ${l}`)));
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Fabric 설치 실패 (exit ${code})`)));
      proc.on('error', reject);
    });
    await fs.writeFile(verFile, this.config.version);
    this.onLog('[DevKit] Fabric 설치 완료 ✓');
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

    // 필수 설정
    props = set('enable-rcon',   'true');
    props = set('rcon.port',     '25575');
    props = set('rcon.password', this.config.rconPassword);
    props = set('online-mode',   'true');

    // 핑·TPS 최적화 (이미 설정된 경우 덮어쓰지 않음)
    const setIfNew = (key, val) => {
      const re = new RegExp(`^${key}=`, 'm');
      if (!re.test(props)) props = props + `\n${key}=${val}`;
    };
    setIfNew('view-distance',               '6');   // 청크 거리 축소 → TPS↑
    setIfNew('simulation-distance',         '4');   // 엔티티 시뮬 범위 축소 → TPS↑
    setIfNew('network-compression-threshold','256'); // 소형 패킷 압축 스킵 → 핑↓
    setIfNew('use-native-transport',        'true'); // Netty 네이티브 I/O
    setIfNew('entity-broadcast-range-percentage', '75'); // 엔티티 브로드캐스트 범위 축소
    setIfNew('max-tick-time',               '-1');  // 서버 워치독 비활성화 (개발용)

    await fs.writeFile(propsPath, props);
  }

  // ── Fabric 성능 모드 자동 설치 ──────────────────────────────────────────
  async _ensureFabricPerfMods() {
    // Lithium: 게임 로직 최적화 (TPS)
    // Krypton: 네트워크 스택 최적화 (핑 감소)
    // FerriteCore: 메모리 절약 (GC 감소)
    const PERF_MODS = [
      { id: 'lithium',     name: 'Lithium'     },
      { id: 'krypton',     name: 'Krypton'     },
      { id: 'ferrite-core',name: 'FerriteCore' },
    ];

    const modsDir = path.join(this.config.serverDir, 'mods');
    await fs.ensureDir(modsDir);

    const mcVer = this.config.version;

    for (const mod of PERF_MODS) {
      const marker = path.join(modsDir, `.perfmod_${mod.id}`);
      if (await fs.pathExists(marker)) continue;

      try {
        this.onLog(`[DevKit] ${mod.name} 성능 모드 설치 중...`);

        const { data: versions } = await axios.get(
          `https://api.modrinth.com/v2/project/${mod.id}/version`,
          {
            params: {
              loaders:       JSON.stringify(['fabric']),
              game_versions: JSON.stringify([mcVer]),
            },
            headers: { 'User-Agent': 'mc-devkit/1.0' },
            timeout: 10000,
          }
        );

        if (!versions?.length) {
          this.onLog(`[DevKit] ${mod.name}: MC ${mcVer} 호환 버전 없음 — 건너뜀`);
          continue;
        }

        const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
        if (!file) continue;

        const resp = await axios.get(file.url, {
          responseType: 'arraybuffer', maxRedirects: 10, timeout: 30000,
          headers: { 'User-Agent': 'mc-devkit/1.0' },
        });

        const dest = path.join(modsDir, file.filename);
        await fs.writeFile(dest, resp.data);
        await fs.writeFile(marker, '');   // 설치 완료 마커
        this.onLog(`[DevKit] ${mod.name} 설치 완료 ✓ (${file.filename})`);
      } catch (e) {
        this.onLog(`[DevKit] ${mod.name} 설치 실패 — ${e.message}`);
      }
    }
  }

  // ── Paper 성능 config 자동 생성 ──────────────────────────────────────────
  async _writePaperConfig() {
    // paper-global.yml (Paper 1.19+)
    const globalDir  = path.join(this.config.serverDir, 'config');
    const globalFile = path.join(globalDir, 'paper-global.yml');
    await fs.ensureDir(globalDir);

    if (!await fs.pathExists(globalFile)) {
      await fs.writeFile(globalFile, [
        '# Auto-generated by MC DevKit for performance',
        'chunk-loading-basic:',
        '  autoconfig-send-distance: true',
        'chunk-system:',
        '  worker-threads: -1',          // CPU 수에 맞게 자동
        'misc:',
        '  use-alternative-luck-formula: false',
        'packet-limiter:',
        '  max-packet-rate: 500.0',      // 패킷 제한 완화 (dev server)
        'timings:',
        '  enabled: false',              // timings 비활성화 → 오버헤드 제거
        '',
      ].join('\n'));
    }

    // paper-world-defaults.yml (Paper 1.19+)
    const worldFile = path.join(globalDir, 'paper-world-defaults.yml');
    if (!await fs.pathExists(worldFile)) {
      await fs.writeFile(worldFile, [
        '# Auto-generated by MC DevKit for performance',
        'chunks:',
        '  auto-save-interval: 12000',   // 10분마다 저장 (기본 6000=5분) → 세이브 스파이크 감소
        '  delay-chunk-unloads-by: 10s',
        '  entity-per-chunk-save-limit:',
        '    experience_orb: 64',
        '    arrow: 16',
        '    dragon_fireball: 3',
        '    egg: 8',
        '    fireball: 8',
        '    small_fireball: 8',
        '    firework_rocket: 8',
        '    snowball: 8',
        '    spectral_arrow: 16',
        '    experience_bottle: 3',
        'entities:',
        '  spawning:',
        '    per-player-mob-spawns: true', // 플레이어별 몹 스폰 → 스폰 루프 최적화
        '    despawn-ranges:',
        '      ambient:   { hard: 72, soft: 32 }',
        '      axolotls:  { hard: 72, soft: 32 }',
        '      creature:  { hard: 72, soft: 32 }',
        '      monster:   { hard: 72, soft: 32 }',
        '      misc:      { hard: 72, soft: 32 }',
        '      underground_water_creature: { hard: 72, soft: 32 }',
        '      water_ambient:  { hard: 72, soft: 32 }',
        '      water_creature: { hard: 72, soft: 32 }',
        'environment:',
        '  optimize-explosions: true',
        '  treasure-maps:',
        '    enabled: false',            // 보물 지도 검색 → 심각한 lag 유발
        'misc:',
        '  max-leash-distance: 10.0',
        '  redstone-implementation: ALTERNATE_CURRENT', // 최적화된 레드스톤 엔진
        '',
      ].join('\n'));
    }
  }

  // ── 포트 25565 점유 프로세스 강제 종료 (고아 JVM 정리) ───────────────────────
  async _killOrphan() {
    if (process.platform !== 'win32') return;
    try {
      const out = execSync('netstat -ano 2>nul', { encoding: 'utf8', timeout: 5000 });
      const lines = out.split('\n').filter(l => l.includes(':25565') && l.includes('LISTENING'));
      for (const line of lines) {
        const m = line.trim().split(/\s+/).pop();
        if (m && /^\d+$/.test(m) && m !== '0') {
          this.onLog(`[DevKit] 고아 서버 프로세스(PID ${m}) 종료 중...`);
          execSync(`taskkill /F /PID ${m} 2>nul`, { stdio: 'ignore', timeout: 5000 });
        }
      }
      // 종료 완료 대기
      execSync('ping -n 2 127.0.0.1 > nul', { stdio: 'ignore', timeout: 3000 });
    } catch { /* 고아 없음 또는 이미 종료됨 */ }
  }

  // ── 서버 시작 (완전 자동) ──────────────────────────────────────────────────
  async start() {
    if (this.status !== 'stopped') throw new Error('서버가 이미 실행 중입니다.');
    await this._killOrphan();

    this.status    = 'starting';
    this._stopping = false;

    try {
      const javaPath = await this._ensureJava();
      await fs.writeFile(path.join(this.config.serverDir, 'eula.txt'), 'eula=true\n');
      await this._writeServerProps();

      let jarArgs;
      if (this.config.serverType === 'fabric') {
        await this._ensureFabric();
        jarArgs = ['fabric-server-launch.jar', 'nogui'];
        this.onLog('[DevKit] Fabric 서버 시작 중...');
      } else {
        await this._ensurePaper();
        await this._ensurePlugManX();
        jarArgs = ['paper.jar', '--nogui'];
        this.onLog('[DevKit] Paper 서버 시작 중...');
      }

      const cpuCount  = os.cpus().length;
      const gcThreads = Math.min(cpuCount, 8);

      const aikarFlags = [
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        `-XX:ParallelGCThreads=${gcThreads}`,
        `-XX:ConcGCThreads=${Math.max(1, Math.floor(gcThreads / 4))}`,
        '-Dusing.aikars.flags=https://mcflags.emc.gs',
        '-Daikars.new.flags=true',
      ];

      if (this.config.serverType === 'fabric') {
        await this._ensureFabricPerfMods();
      } else {
        await this._writePaperConfig();
      }

      this.process = spawn(
        javaPath,
        [
          `-Xmx${this.config.memory}`,
          `-Xms${this.config.memory}`,
          ...aikarFlags,
          '-jar', ...jarArgs,
        ],
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
        const now = Date.now();
        this._crashTimes = this._crashTimes.filter(t => now - t < 60000);
        this._crashTimes.push(now);

        if (this._crashTimes.length >= 3) {
          this.onLog('[DevKit] ✖ 1분 내 3회 이상 크래시 — 자동 재시작 중단. 수동으로 시작해주세요.');
          this._crashTimes = [];
        } else {
          this.onLog('[DevKit] ⚠ 비정상 종료 감지 — 10초 후 자동 재시작...');
          this.onCrash();
          setTimeout(() => {
            this.start().catch(e => this.onLog(`[DevKit] 자동 재시작 실패: ${e.message}`));
          }, 10000);
        }
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
