'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const axios = require('axios');

const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

class TunnelManager {
  constructor(port, onLog, onTunnelReady) {
    this.port = port;           // DevKit 웹 대시보드 포트 (3847)
    this.onLog = onLog;
    this.onTunnelReady = onTunnelReady;   // (url) => void
    this.process = null;
    this.tunnelUrl = null;
  }

  // ── cloudflared 바이너리 경로 ────────────────────────────────────────────────
  _binaryPath() {
    const dir = path.join(os.homedir(), '.mc-devkit');
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(dir, name);
  }

  // ── 플랫폼별 다운로드 URL ────────────────────────────────────────────────────
  _downloadUrl() {
    const { platform, arch } = process;
    const map = {
      'darwin-x64':    'cloudflared-darwin-amd64',
      'darwin-arm64':  'cloudflared-darwin-arm64',
      'linux-x64':     'cloudflared-linux-amd64',
      'linux-arm64':   'cloudflared-linux-arm64',
      'win32-x64':     'cloudflared-windows-amd64.exe',
    };
    const key = `${platform}-${arch}`;
    const filename = map[key];
    if (!filename) throw new Error(`지원하지 않는 플랫폼: ${key}`);
    return `${CLOUDFLARED_RELEASES}/${filename}`;
  }

  // ── cloudflared 설치 확인 + 없으면 자동 다운로드 ────────────────────────────
  async _ensureInstalled() {
    const binPath = this._binaryPath();

    // 이미 있으면 스킵
    if (await fs.pathExists(binPath)) return binPath;

    this.onLog('[DevKit] cloudflared 설치 중...');
    await fs.ensureDir(path.dirname(binPath));

    const url = this._downloadUrl();
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(binPath, response.data);

    // 실행 권한 부여 (Unix)
    if (process.platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }

    this.onLog('[DevKit] cloudflared 설치 완료 ✓');
    return binPath;
  }

  // ── 터널 시작 ───────────────────────────────────────────────────────────────
  async start() {
    if (this.process) throw new Error('터널이 이미 실행 중입니다.');

    const binPath = await this._ensureInstalled();
    this.onLog(`[DevKit] 터널 생성 중 (포트 ${this.port})...`);

    this.process = spawn(binPath, [
      'tunnel', '--url', `http://localhost:${this.port}`
    ]);

    // cloudflared는 URL을 stderr로 출력
    this.process.on('error', (err) => {
      this.process = null;
      this.onLog(`[DevKit] cloudflared 실행 오류: ${err.message}`);
    });

    this.process.stderr.on('data', (data) => {
      const text = data.toString();

      // 터널 URL 파싱
      const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
      if (match && !this.tunnelUrl) {
        this.tunnelUrl = match[0];
        this.onLog(`[DevKit] 터널 URL: ${this.tunnelUrl}`);
        this.onTunnelReady(this.tunnelUrl);
      }
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.tunnelUrl = null;
      if (code !== 0) this.onLog(`[DevKit] 터널 종료 (exit: ${code})`);
    });
  }

  // ── 터널 중지 ───────────────────────────────────────────────────────────────
  stop() {
    this.process?.kill();
    this.process = null;
    this.tunnelUrl = null;
    this.onLog('[DevKit] 터널 중지됨');
  }

  getUrl() {
    return this.tunnelUrl;
  }
}

module.exports = TunnelManager;
