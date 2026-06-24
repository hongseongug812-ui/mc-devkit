'use strict';

const { spawn } = require('child_process');
const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const axios = require('axios');

// v0.15.x = claim URL 방식 (v1.x는 IPC 전용이라 사용 불가)
const PLAYIT_VERSION = 'v0.15.26';
const RELEASES = `https://github.com/playit-cloud/playit-agent/releases/download/${PLAYIT_VERSION}`;

class PlayitManager {
  constructor(onLog, onClaimUrl, onTunnelReady) {
    this.onLog         = onLog;
    this.onClaimUrl    = onClaimUrl;    // (url) => void  — 계정 연결 URL
    this.onTunnelReady = onTunnelReady; // (addr) => void — 터널 주소 확보
    this.process  = null;
    this.address  = null;
    this.claimUrl = null;
    this.secretKey = null;
  }

  setSecretKey(key) { this.secretKey = key || null; }

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
    // v1.x 데몬 바이너리가 남아있으면 삭제 후 v0.15.x 재다운로드
    if (await fs.pathExists(bin)) {
      try {
        const { execSync } = require('child_process');
        const ver = execSync(`"${bin}" --version 2>&1`, { timeout: 3000 }).toString();
        if (ver.includes('1.0.') || ver.includes('playitd')) {
          this.onLog('[DevKit] v1.x 바이너리 감지 → v0.15.x로 교체 중...');
          await fs.remove(bin);
        } else {
          return bin;
        }
      } catch {
        return bin;
      }
    }

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

    const args = this.secretKey ? ['--secret_key', this.secretKey] : [];
    this.process = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    this.process.on('error', (err) => {
      this.process = null;
      this.onLog(`[DevKit] playit 오류: ${err.message}`);
    });

    const parse = (text) => {
      // 계정 claim URL — v0.15.x: "https://playit.gg/claim/..." 또는 "claim=" 포함
      const claim = text.match(/https?:\/\/(?:www\.)?playit\.gg\/(?:claim\/[^\s\n]+|[^\s\n]+claim=[^\s\n]+)/);
      if (claim && !this.claimUrl) {
        this.claimUrl = claim[0].trim();
        this.onLog(`[DevKit] playit 계정 연결 URL: ${this.claimUrl}`);
        this.onClaimUrl(this.claimUrl);
      }

      // 터널 주소 — playit 버전별 다양한 출력 패턴
      const patterns = [
        // v0.15.26 "xxx.gl.joinmc.link -> 127.0.0.1:25565"
        /([\w\-]+(?:\.[\w\-]+)*\.joinmc\.link(?::\d+)?)\s*->/i,
        // v0.15+ "Global: xxx.joinmc.link[:PORT]"
        /Global:\s*([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
        // "address: [xxx.at.playit.gg:12345]" or "address=xxx:PORT" (브래킷 포함)
        /address[=:\s]+\[?([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)\]?/i,
        // "connect to xxx.joinmc.link:PORT"
        /connect(?:\s+to)?[=:\s]+([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
        // 포트 있는 경우 (xxx.at.playit.gg:PORT 또는 xxx.joinmc.link:PORT)
        /\[?([\w.\-]+\.(?:playit\.gg|joinmc\.link):\d{4,5})\]?/i,
        // 포트 없는 경우 (xxx.gl.joinmc.link 등 다단계 서브도메인)
        /\b([\w\-]+(?:\.[\w\-]+)*\.joinmc\.link)\b/i,
        // v1.x daemon 로그: "mc_addr=xxx:PORT"
        /(?:mc_addr|alloc_addr|address)=([\w.\-]+\.(?:playit\.gg|joinmc\.link)(?::\d+)?)/i,
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
      this.process  = null;
      this.address  = null;
      this.claimUrl = null;
      if (!this._stopped) {
        this.onLog(`[DevKit] playit 연결 끊김 (exit: ${code}) — 5초 후 재시작...`);
        this._restartTimer = setTimeout(() => {
          if (!this._stopped) this.start().catch(e => this.onLog(`[DevKit] playit 재시작 실패: ${e.message}`));
        }, 5000);
      } else {
        this.onLog(`[DevKit] playit 중지됨`);
      }
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
