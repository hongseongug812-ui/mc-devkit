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
    // config: { projectDir, serverDir, pluginName, buildCmd }
    this.config = config;
    this.rcon = rcon;
    this.onLog = onLog;
    this.watcher = null;
    this.building = false;
    this._debounceTimer = null;
  }

  // ── 심링크 생성 (Windows는 복사 폴백) ───────────────────────────────────────
  async _linkJar() {
    const jars = await glob(`${this.config.projectDir}/build/libs/*.jar`, {
      ignore: ['**/*-sources.jar', '**/*-javadoc.jar']
    });

    if (jars.length === 0) throw new Error('빌드된 jar 파일을 찾을 수 없습니다.');

    const src = path.resolve(jars[0]);
    const dest = path.join(this.config.serverDir, 'plugins', `${this.config.pluginName}.jar`);

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

      await this._linkJar();
      await this._reload();

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
      await this.rcon.sendSafe(`plugman reload ${this.config.pluginName}`);
      this.onLog(`[DevKit] ${this.config.pluginName} 리로드 완료 ✓`);
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
