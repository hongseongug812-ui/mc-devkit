'use strict';

const chokidar = require('chokidar');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const { glob } = require('glob');

const execAsync = promisify(exec);

class BuildWatcher {
  constructor(config, rcon, onLog) {
    // config: { projectDir, serverDir, serverType, serverFolder, pluginName, buildCmd }
    this.config = config;
    this.rcon = rcon;
    this.onLog = onLog;
    this.watcher = null;
    this.building = false;
    this._debounceTimer = null;
  }

  // 프로필별 독립 폴더 (server-manager / server.js activeServerDir()와 동일 로직)
  _activeServerDir() {
    return path.join(this.config.serverDir, this.config.serverFolder || this.config.serverType || 'paper');
  }

  // 프로젝트 리소스로 빌드 산출물 종류 판별
  // - 'mod'          : Fabric 모드 (fabric.mod.json) → mods/, 핫 리로드 불가
  // - 'plugin-modern': Paper 신형 플러그인 (paper-plugin.yml) → plugins/, PlugManX가 리로드 못 함 (PluginBootstrap 구조)
  // - 'plugin-legacy': 레거시 Bukkit 플러그인 (plugin.yml) → plugins/, PlugManX 리로드 가능
  // (Arclight/Cardboard처럼 모드+플러그인이 공존하는 하이브리드 서버 대응)
  async _detectArtifactKind() {
    const res = path.join(this.config.projectDir, 'src', 'main', 'resources');
    if (await fs.pathExists(path.join(res, 'fabric.mod.json'))) return 'mod';
    if (await fs.pathExists(path.join(res, 'paper-plugin.yml'))) return 'plugin-modern';
    if (await fs.pathExists(path.join(res, 'plugin.yml'))) return 'plugin-legacy';
    // 판별 불가 → 서버 타입으로 폴백 (순수 fabric이면 mod, 그 외엔 레거시 플러그인으로 간주)
    return this.config.serverType === 'fabric' ? 'mod' : 'plugin-legacy';
  }

  // ── 심링크 생성 (Windows는 복사 폴백) ───────────────────────────────────────
  async _linkJar() {
    const jars = await glob(`${this.config.projectDir}/build/libs/*.jar`, {
      ignore: ['**/*-sources.jar', '**/*-javadoc.jar']
    });

    if (jars.length === 0) throw new Error('빌드된 jar 파일을 찾을 수 없습니다.');

    const kind = await this._detectArtifactKind();
    const folder = kind === 'mod' ? 'mods' : 'plugins';

    const src = path.resolve(jars[0]);
    const dest = path.join(this._activeServerDir(), folder, `${this.config.pluginName}.jar`);

    await fs.ensureDir(path.dirname(dest));

    // 기존 심링크/파일 제거
    if (await fs.pathExists(dest)) await fs.remove(dest);

    try {
      await fs.symlink(src, dest);
      this.onLog(`[DevKit] 심링크 연결 → ${dest}`);
    } catch {
      // Windows 권한 문제 시 복사로 폴백
      await fs.copy(src, dest);
      this.onLog(`[DevKit] 파일 복사 완료 → ${dest}`);
    }

    return kind;
  }

  // ── Gradle 빌드 실행 ────────────────────────────────────────────────────────
  async _build() {
    if (this.building) return;

    // buildCmd 없으면 gradlew 존재 여부 먼저 확인
    if (!this.config.buildCmd) {
      const gradlew = path.join(this.config.projectDir,
        process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      if (!fs.pathExistsSync(gradlew)) return; // Gradle 없음 → 조용히 건너뜀
    }

    this.building = true;
    this.onLog('[DevKit] 빌드 시작...');
    const startTime = Date.now();

    try {
      const defaultCmd = process.platform === 'win32' ? 'gradlew.bat build -x test' : './gradlew build -x test';
      const cmd = this.config.buildCmd || defaultCmd;
      await execAsync(cmd, { cwd: this.config.projectDir });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.onLog(`[DevKit] 빌드 성공 ✓ (${elapsed}초)`);

      const kind = await this._linkJar();
      if (kind === 'mod') {
        // Fabric 모드는 클래스 리로드가 불가능 — 반영하려면 서버 재시작 필요
        this.onLog(`[DevKit] 모드는 핫 리로드를 지원하지 않습니다 — 서버를 재시작해야 적용됩니다.`);
      } else if (kind === 'plugin-modern') {
        // paper-plugin.yml(PluginBootstrap) 방식은 PlugManX가 리로드할 수 없는 구조
        this.onLog(`[DevKit] paper-plugin.yml(신형) 플러그인은 PlugManX로 핫 리로드가 불가능합니다 — 서버를 재시작해야 적용됩니다.`);
      } else {
        await this._reload();
      }

    } catch (err) {
      this.onLog(`[DevKit] 빌드 실패 ✗ — ${err.message.split('\n')[0]}`);
      // stderr/stdout에 실제 컴파일 에러가 있으면 추가 출력
      const detail = (err.stderr || err.stdout || '').trim();
      if (detail) {
        detail.split('\n').slice(-8).forEach(l => this.onLog(l));  // 마지막 8줄만
      }
    } finally {
      this.building = false;
    }
  }

  // ── PlugManX로 개별 플러그인 리로드 ────────────────────────────────────────
  async _reload() {
    try {
      this.onLog(`[DevKit] 플러그인 리로드 중...`);
      const resp = (await this.rcon.sendSafe(`plugman reload ${this.config.pluginName}`) || '').trim();

      // RCON 호출 자체는 성공해도 PlugManX가 실패 메시지를 응답으로 줄 수 있음 (예외로 안 잡힘)
      const failed = !resp || /not found|no such|unknown command|does not exist|찾을 수 없|실패|error/i.test(resp);
      if (failed) {
        this.onLog(`[DevKit] ${this.config.pluginName} 리로드 실패 — 서버 응답: "${resp || '(응답 없음)'}"`);
        this.onLog(`[DevKit] PlugManX가 이 서버 환경(하이브리드 등)에서 리로드를 지원하지 않을 수 있습니다 — 서버 재시작을 권장합니다.`);
      } else {
        this.onLog(`[DevKit] ${this.config.pluginName} 리로드 완료 ✓ — 서버 응답: "${resp}"`);
      }
    } catch (err) {
      this.onLog(`[DevKit] RCON 리로드 실패 — ${err.message}`);
    }
  }

  // ── 파일 와처 시작 ──────────────────────────────────────────────────────────
  start() {
    const srcPath  = path.join(this.config.projectDir, 'src');
    const watchPath = fs.pathExistsSync(srcPath) ? srcPath : this.config.projectDir;

    if (!fs.pathExistsSync(watchPath)) {
      this.onLog('[DevKit] 프로젝트 폴더가 없어 파일 감시를 건너뜁니다.');
      return;
    }

    this.onLog(`[DevKit] 파일 감시 시작 → ${watchPath}`);

    const serverDirAbs = path.resolve(this.config.serverDir);
    this.watcher = chokidar.watch(watchPath, {
      ignored: [
        /(node_modules|\.git|build|\.gradle|out)(\/|\\|$)/,
        (p) => p.startsWith(serverDirAbs + path.sep) || p === serverDirAbs,
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 10,
    });

    this.watcher.on('change', (filePath) => {
      this.onLog(`[DevKit] 변경 감지: ${path.basename(filePath)}`);
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._build(), 1500);
    });

    this.watcher.on('error', (err) => {
      this.onLog(`[DevKit] 와처 오류 — ${err.message}`);
    });
  }

  // ── 파일 와처 중지 ──────────────────────────────────────────────────────────
  async stop() {
    clearTimeout(this._debounceTimer);
    await this.watcher?.close();
    this.watcher = null;
    this.onLog('[DevKit] 파일 감시 중지됨');
  }

  // ── 수동 빌드 트리거 (대시보드 버튼용) ─────────────────────────────────────
  async triggerBuild() {
    await this._build();
  }
}

module.exports = BuildWatcher;
