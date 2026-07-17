'use strict';

const { spawn, execSync } = require('child_process');
const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const axios = require('axios');

const PURPUR_API   = 'https://api.purpurmc.org/v2/purpur';
const ADOPTIUM_API = 'https://api.adoptium.net/v3/binary/latest/21/ga';
const FABRIC_META  = 'https://meta.fabricmc.net/v2/versions/installer';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer';
const MOJANG_META  = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
const ARCLIGHT_RELEASES = 'https://api.github.com/repos/IzzelAliz/Arclight/releases';
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
    this._crashTimes = [];
  }

  // 프로필별 독립 폴더 (serverFolder 우선, 없으면 serverType 폴백)
  get _dir() {
    return path.join(this.config.serverDir, this.config.serverFolder || this.config.serverType || 'paper');
  }

  // Adoptium 압축 해제 후 java 실행 파일 경로
  // macOS 배포판은 .app 번들 구조(Contents/Home/bin/java)로 풀림, Win/Linux는 바로 bin/에 풀림
  get _jreJavaExe() {
    return process.platform === 'darwin'
      ? path.join(JRE_DIR, 'Contents', 'Home', 'bin', 'java')
      : path.join(JRE_DIR, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
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
    // Arclight(Forge 기반)은 Java 21까지만 안정 지원 → 초과 시 내부 JRE 21로 대체
    const forgeType = this.config.serverType === 'arclight';
    try {
      const out   = execSync('java -version 2>&1', { encoding: 'utf8' });
      const ver   = out.split('\n')[0];
      const m     = ver.match(/"([\d.]+)"/);
      if (m) {
        const parts = m[1].split('.');
        const major = parts[0] === '1' ? parseInt(parts[1]) : parseInt(parts[0]);
        if (major < 17) {
          this.onLog(`[DevKit] Java ${major} 감지 — Java 17 미만은 지원하지 않습니다. 내부 JRE 21로 대체합니다.`);
        } else if (forgeType && major > 21) {
          this.onLog(`[DevKit] Java ${major} 감지 — Arclight는 Java 21까지 지원합니다. 내부 JRE 21로 대체합니다.`);
        } else {
          this.onLog(`[DevKit] 시스템 Java ${major} 사용`);
          this._javaPath = 'java';
          return 'java';
        }
      }
    } catch {}

    // 2. 이전에 내려받은 JRE 재사용
    const javaExe = this._jreJavaExe;
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

  // ── Purpur 최신 빌드 번호 조회 ─────────────────────────────────────────────
  async _getLatestBuild(version) {
    const { data } = await axios.get(`${PURPUR_API}/${version}/latest`);
    if (!data.build) throw new Error(`Paper(Purpur) ${version} 빌드를 찾을 수 없습니다.`);
    return data.build;
  }

  // ── PlugManX 자동 설치 ──────────────────────────────────────────────────────
  async _ensurePlugManX() {
    const pluginsDir = path.join(this._dir, 'plugins');
    await fs.ensureDir(pluginsDir);

    const files = await fs.readdir(pluginsDir);
    if (files.some(f => /plugman/i.test(f) && f.endsWith('.jar'))) return;

    this.onLog('[DevKit] PlugManX 다운로드 중...');
    try {
      const { data: releases } = await axios.get(
        'https://api.github.com/repos/tiecia/PlugManX-releases/releases',
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
    const jarPath  = path.join(this._dir, 'paper.jar');
    const verFile  = path.join(this._dir, '.paper-version');
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
        await fs.ensureDir(this._dir);
        await fs.copy(bundled, jarPath);
        await fs.writeFile(verFile, this.config.version);
        return;
      }
    }

    this.onLog(`[DevKit] Paper ${this.config.version} 다운로드 중...`);
    const url = `${PURPUR_API}/${this.config.version}/latest/download`;

    await fs.ensureDir(this._dir);
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(jarPath, resp.data);
    await fs.writeFile(verFile, this.config.version);
    this.onLog(`[DevKit] Paper 다운로드 완료 ✓`);
  }

  // ── Fabric 서버 설치 ────────────────────────────────────────────────────────
  async _ensureFabric() {
    const launchJar = path.join(this._dir, 'fabric-server-launch.jar');
    const verFile   = path.join(this._dir, '.fabric-version');
    const savedVer  = await fs.pathExists(verFile) ? (await fs.readFile(verFile, 'utf8')).trim() : null;

    // 버전이 바뀌었으면 기존 jar 삭제 후 재설치
    if (savedVer !== this.config.version && await fs.pathExists(launchJar)) {
      this.onLog(`[DevKit] Fabric 버전 변경 (${savedVer} → ${this.config.version}), 재설치 중...`);
      await fs.remove(launchJar);
    }

    if (await fs.pathExists(launchJar)) return;

    await fs.ensureDir(this._dir);

    // 최신 인스톨러 버전 조회 후 다운로드
    this.onLog('[DevKit] Fabric 인스톨러 다운로드 중...');
    const { data: versions } = await axios.get(FABRIC_META);
    const ver = versions[0].version;
    const installerUrl = `${FABRIC_MAVEN}/${ver}/fabric-installer-${ver}.jar`;
    const instPath = path.join(this._dir, 'fabric-installer.jar');
    const resp = await axios.get(installerUrl, { responseType: 'arraybuffer', maxRedirects: 10 });
    await fs.writeFile(instPath, resp.data);

    // 인스톨러 실행 → fabric-server-launch.jar 생성
    this.onLog(`[DevKit] Fabric 서버 설치 중 (MC ${this.config.version})...`);
    const javaPath = await this._ensureJava();
    await new Promise((resolve, reject) => {
      const proc = spawn(javaPath, [
        '-jar', 'fabric-installer.jar',
        'server', '-mcversion', this.config.version, '-downloadMinecraft',
      ], { cwd: this._dir, stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => this.onLog(`[Fabric] ${l}`, 'stdout')));
      proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => this.onLog(`[Fabric] ${l}`, 'stderr')));
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Fabric 설치 실패 (exit ${code})`)));
      proc.on('error', reject);
    });
    await fs.writeFile(verFile, this.config.version);
    this.onLog('[DevKit] Fabric 설치 완료 ✓');
  }

  // ── Cardboard 모드 확보 (Fabric + Bukkit 하이브리드) ─────────────────────────
  async _ensureCardboard() {
    const modsDir  = path.join(this._dir, 'mods');
    await fs.ensureDir(modsDir);

    const verFile  = path.join(modsDir, '.cardboard-version');
    const savedVer = await fs.pathExists(verFile) ? (await fs.readFile(verFile, 'utf8')).trim() : null;

    // 버전이 바뀌었으면 기존 모드 제거 후 전체 재다운로드
    if (savedVer && savedVer !== this.config.version) {
      const old = await fs.readdir(modsDir);
      for (const f of old) {
        if (/^(cardboard|icommon|fabric-api)-/i.test(f)) await fs.remove(path.join(modsDir, f));
      }
    }

    const CARDBOARD_MODS = [
      { id: 'fabric-api', name: 'Fabric API', match: /^fabric-api-/i },
      { id: 'icommon',    name: 'iCommonLib', match: /^icommon-/i   },
      { id: 'cardboard',  name: 'Cardboard',  match: /^cardboard-/i },
    ];

    // 버전 마커만 믿지 않고 실제 jar 존재를 확인 — 삭제된 모드만 다시 받는다
    const existing = await fs.readdir(modsDir);
    const missing  = CARDBOARD_MODS.filter(m =>
      !existing.some(f => f.endsWith('.jar') && m.match.test(f)));

    if (missing.length === 0) {
      if (savedVer !== this.config.version) await fs.writeFile(verFile, this.config.version);
      return;
    }

    for (const mod of missing) {
      this.onLog(`[DevKit] ${mod.name} 다운로드 중...`);
      const { data: versions } = await axios.get(
        `https://api.modrinth.com/v2/project/${mod.id}/version`,
        {
          params: {
            loaders:       JSON.stringify(['fabric']),
            game_versions: JSON.stringify([this.config.version]),
          },
          headers: { 'User-Agent': 'mc-devkit/1.0' },
          timeout: 10000,
        }
      );
      if (!versions?.length) {
        throw new Error(`${mod.name}: MC ${this.config.version} 호환 버전이 없습니다. 다른 버전을 선택해주세요.`);
      }

      const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
      if (!file) throw new Error(`${mod.name}: 다운로드 파일을 찾을 수 없습니다.`);

      const resp = await axios.get(file.url, {
        responseType: 'arraybuffer', maxRedirects: 10, timeout: 30000,
        headers: { 'User-Agent': 'mc-devkit/1.0' },
      });
      await fs.writeFile(path.join(modsDir, file.filename), resp.data);
      this.onLog(`[DevKit] ${mod.name} 설치 완료 ✓ (${file.filename})`);
    }

    await fs.writeFile(verFile, this.config.version);
  }

  // ── Arclight 서버 jar 확보 (Forge/NeoForge + Bukkit 하이브리드) ──────────────
  async _ensureArclight() {
    const jarPath = path.join(this._dir, 'arclight.jar');
    const verFile = path.join(this._dir, '.arclight-version');
    const savedVer = await fs.pathExists(verFile) ? (await fs.readFile(verFile, 'utf8')).trim() : null;

    if (savedVer !== this.config.version && await fs.pathExists(jarPath)) {
      this.onLog(`[DevKit] Arclight 버전 변경 (${savedVer} → ${this.config.version}), 재다운로드 중...`);
      await fs.remove(jarPath);
    }

    if (await fs.pathExists(jarPath)) return;

    this.onLog(`[DevKit] Arclight ${this.config.version} 최신 릴리스 검색 중...`);
    await fs.ensureDir(this._dir);

    const { data: releases } = await axios.get(
      `${ARCLIGHT_RELEASES}?per_page=50`,
      { headers: { 'User-Agent': 'mc-devkit' }, timeout: 15000 }
    );

    let downloadUrl = null;
    let assetName   = null;

    // forge → neoforge → fabric 순으로 우선 선택
    for (const rel of releases) {
      if (rel.prerelease || rel.tag_name.includes('SNAPSHOT')) continue;
      for (const loader of ['forge', 'neoforge', 'fabric']) {
        const asset = rel.assets.find(a =>
          a.name.startsWith(`arclight-${loader}-${this.config.version}-`)
        );
        if (asset) { downloadUrl = asset.browser_download_url; assetName = asset.name; break; }
      }
      if (downloadUrl) break;
    }

    if (!downloadUrl) throw new Error(`Arclight ${this.config.version} 다운로드 URL을 찾을 수 없습니다.`);

    this.onLog(`[DevKit] Arclight 다운로드 중... (${assetName})`);
    const resp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer', maxRedirects: 10,
      headers: { 'User-Agent': 'mc-devkit' }, timeout: 180000,
    });
    await fs.writeFile(jarPath, resp.data);
    await fs.writeFile(verFile, this.config.version);
    this.onLog('[DevKit] Arclight 다운로드 완료 ✓');
    this.onLog('[DevKit] ⚠ 최초 실행 시 Forge/NeoForge 설치로 수 분 소요될 수 있습니다.');
  }

  // ── Vanilla 서버 jar 확보 ──────────────────────────────────────────────────
  async _ensureVanilla() {
    const jarPath = path.join(this._dir, 'server.jar');
    const verFile = path.join(this._dir, '.vanilla-version');
    const savedVer = await fs.pathExists(verFile) ? (await fs.readFile(verFile, 'utf8')).trim() : null;

    if (savedVer !== this.config.version && await fs.pathExists(jarPath)) {
      this.onLog(`[DevKit] Vanilla 버전 변경 (${savedVer} → ${this.config.version}), 재다운로드 중...`);
      await fs.remove(jarPath);
    }

    if (await fs.pathExists(jarPath)) return;

    this.onLog(`[DevKit] Vanilla ${this.config.version} 다운로드 중...`);
    await fs.ensureDir(this._dir);

    const { data: manifest } = await axios.get(MOJANG_META);
    const entry = manifest.versions.find(v => v.id === this.config.version);
    if (!entry) throw new Error(`Vanilla ${this.config.version} 버전을 찾을 수 없습니다.`);

    const { data: meta } = await axios.get(entry.url);
    const serverUrl = meta.downloads?.server?.url;
    if (!serverUrl) throw new Error(`Vanilla ${this.config.version} 서버 jar URL 없음`);

    const resp = await axios.get(serverUrl, { responseType: 'arraybuffer', maxRedirects: 10 });
    await fs.writeFile(jarPath, resp.data);
    await fs.writeFile(verFile, this.config.version);
    this.onLog('[DevKit] Vanilla 다운로드 완료 ✓');
  }

  // ── server.properties 자동 설정 ────────────────────────────────────────────
  async _writeServerProps() {
    const propsPath = path.join(this._dir, 'server.properties');
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

    const modsDir = path.join(this._dir, 'mods');
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
    const globalDir  = path.join(this._dir, 'config');
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
    this.status    = 'starting';
    this._stopping = false;

    await this._killOrphan();

    try {
      const javaPath = await this._ensureJava();
      await fs.ensureDir(this._dir);
      this.onLog(`[DevKit] 실행 구성: type=${this.config.serverType}, version=${this.config.version}, memory=${this.config.memory}, dir=${this._dir}, java=${javaPath}`);
      await fs.writeFile(path.join(this._dir, 'eula.txt'), 'eula=true\n');
      await this._writeServerProps();

      let jarArgs;
      if (this.config.serverType === 'fabric') {
        await this._ensureFabric();
        await this._ensureFabricPerfMods();
        jarArgs = ['fabric-server-launch.jar', 'nogui'];
        this.onLog('[DevKit] Fabric 서버 시작 중...');
      } else if (this.config.serverType === 'vanilla') {
        await this._ensureVanilla();
        jarArgs = ['server.jar', '--nogui'];
        this.onLog('[DevKit] Vanilla 서버 시작 중...');
      } else if (this.config.serverType === 'arclight') {
        await this._ensureArclight();
        await this._ensurePlugManX();
        jarArgs = ['arclight.jar', '--nogui'];
        this.onLog('[DevKit] Arclight 서버 시작 중... (모드+플러그인 하이브리드)');
      } else if (this.config.serverType === 'cardboard') {
        await this._ensureFabric();
        await this._ensureCardboard();
        await this._ensureFabricPerfMods();
        await this._ensurePlugManX();
        jarArgs = ['fabric-server-launch.jar', 'nogui'];
        this.onLog('[DevKit] Cardboard 서버 시작 중... (모드+플러그인 하이브리드)');
      } else {
        await this._ensurePaper();
        await this._ensurePlugManX();
        await this._writePaperConfig();
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

      this.process = spawn(
        javaPath,
        [
          `-Xmx${this.config.memory}`,
          `-Xms${this.config.memory}`,
          ...aikarFlags,
          '-jar', ...jarArgs,
        ],
        { cwd: this._dir, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      this.status = 'stopped';
      this.onLog(`[DevKit] 시작 실패: ${err.message}`);
      this.onLog(`[DevKit] 스택: ${(err.stack || '').split('\n').slice(0, 6).join(' → ')}`);
      throw err;
    }

    this.process.on('error', (err) => {
      this.status = 'stopped';
      this.process = null;
      this.onLog(`[DevKit] 프로세스 오류: ${err.message}`);
    });

    this.process.stdout.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(line => {
        this.onLog(line, 'stdout');
        if (line.includes('Done') && line.includes('For help')) {
          this.status = 'running';
          this.onLog('[DevKit] 서버 준비 완료 ✓');
        }
      });
    });

    this.process.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(l => this.onLog(l, 'stderr'));
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
