'use strict';

const { spawn } = require('child_process');
const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const axios = require('axios');

const RELEASES = 'https://github.com/playit-cloud/playit-agent/releases/latest/download';

class PlayitManager {
  constructor(onLog, onClaimUrl, onTunnelReady) {
    this.onLog         = onLog;
    this.onClaimUrl    = onClaimUrl;    // (url) => void  — 계정 연결 URL
    this.onTunnelReady = onTunnelReady; // (addr) => void — 터널 주소 확보
    this.process  = null;
    this.address  = null;
    this.claimUrl = null;
  }

  _binPath() {
    const name = process.platform === 'win32' ? 'playit.exe' : 'playit';
    return path.join(os.homedir(), '.mc-devkit', name);
  }

  _downloadUrl() {
    const map = {
      'win32-x64':    'playit-windows-x86_64.exe',
      'linux-x64':    'playit-linux-x86_64',
      'linux-arm64':  'playit-linux-aarch64',
      'darwin-x64':   'playit-darwin-x86_64',
      'darwin-arm64': 'playit-darwin-aarch64',
    };
    const key = `${process.platform}-${process.arch}`;
    const file = map[key];
    if (!file) throw new Error(`지원하지 않는 플랫폼: ${key}`);
    return `${RELEASES}/${file}`;
  }

  async _ensureInstalled() {
    const bin = this._binPath();
    if (await fs.pathExists(bin)) return bin;

    this.onLog('[DevKit] playit-agent 다운로드 중...');
    await fs.ensureDir(path.dirname(bin));

    const resp = await axios.get(this._downloadUrl(), {
      responseType: 'arraybuffer', maxRedirects: 10,
    });
    await fs.writeFile(bin, resp.data);
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);

    this.onLog('[DevKit] playit-agent 설치 완료 ✓');
    return bin;
  }

  async start() {
    if (this.process) throw new Error('playit이 이미 실행 중입니다.');

    const bin = await this._ensureInstalled();
    this.onLog('[DevKit] playit 터널 시작 중...');

    this.process = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.process.on('error', (err) => {
      this.process = null;
      this.onLog(`[DevKit] playit 오류: ${err.message}`);
    });

    const parse = (text) => {
      // 계정 claim URL
      const claim = text.match(/https:\/\/playit\.gg\/[^\s\n]+claim=[^\s\n]+/);
      if (claim && !this.claimUrl) {
        this.claimUrl = claim[0].trim();
        this.onLog(`[DevKit] playit 계정 연결 URL: ${this.claimUrl}`);
        this.onClaimUrl(this.claimUrl);
      }

      // 터널 주소 — playit 버전별 다양한 출력 패턴
      const patterns = [
        // v0.15+ "Global: xxx.joinmc.link:25565"
        /Global:\s*([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
        // "address: xxx.playit.gg:25565"
        /address[:\s]+([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
        // "Tunnel created: xxx:25565"
        /tunnel\s+(?:address|created|ready)[^:]*:\s*([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
        // "Connect: xxx.joinmc.link:25565"
        /connect[:\s]+([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
        // 단독으로 주소만 출력되는 경우 (가장 넓은 패턴, 마지막 순위)
        /([\w.\-]+\.(?:playit\.gg|joinmc\.link):\d{4,5})/i,
      ];
      if (!this.address) {
        for (const pat of patterns) {
          const m = text.match(pat);
          if (m) {
            this.address = m[1].trim();
            this.onLog(`[DevKit] playit 서버 주소: ${this.address}`);
            this.onTunnelReady(this.address);
            break;
          }
        }
      }
    };

    const handle = (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(l => { this.onLog(`[playit] ${l}`); parse(l); });
    };

    this.process.stdout.on('data', handle);
    this.process.stderr.on('data', handle);

    this.process.on('exit', (code) => {
      const wasRunning = !!this.address;
      this.process  = null;
      this.address  = null;
      this.claimUrl = null;
      if (wasRunning || code) this.onLog(`[DevKit] playit 종료 (exit: ${code})`);
    });
  }

  stop() {
    if (!this.process) return;
    this.process.kill();
    this.process  = null;
    this.address  = null;
    this.claimUrl = null;
    this.onLog('[DevKit] playit 중지됨');
  }

  getAddress()  { return this.address; }
  getClaimUrl() { return this.claimUrl; }
  isRunning()   { return !!this.process; }
}

module.exports = PlayitManager;
