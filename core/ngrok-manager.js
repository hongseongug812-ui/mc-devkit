'use strict';

const { spawn, execSync } = require('child_process');
const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const axios = require('axios');

// bore GitHub Releases API
const BORE_REPO = 'https://api.github.com/repos/ekzhang/bore/releases/latest';

class NgrokManager {
  constructor(onLog, onTunnelReady) {
    this.onLog         = onLog;
    this.onTunnelReady = onTunnelReady;
    this.process   = null;
    this.address   = null;
  }

  // authToken 호환용 (서버에서 setAuthToken 호출하므로 빈 메서드 유지)
  setAuthToken() {}

  _binPath() {
    const name = process.platform === 'win32' ? 'bore.exe' : 'bore';
    return path.join(os.homedir(), '.mc-devkit', name);
  }

  async _ensureInstalled() {
    // 시스템 bore 있으면 바로 사용
    try { execSync('bore --version', { stdio: 'ignore', timeout: 3000 }); return 'bore'; } catch {}

    const bin = this._binPath();
    if (await fs.pathExists(bin)) return bin;

    this.onLog('[DevKit] bore 다운로드 중...');

    // 최신 릴리즈 조회
    const { data: release } = await axios.get(BORE_REPO, {
      headers: { 'User-Agent': 'mc-devkit' },
      timeout: 10000,
    });

    const platform = process.platform;
    const arch     = process.arch;
    const keyword  = platform === 'win32'   ? 'windows'
                   : platform === 'darwin'  ? 'apple-darwin'
                   : arch === 'arm64'       ? 'aarch64-unknown-linux'
                   :                          'x86_64-unknown-linux';

    const asset = release.assets.find(a => a.name.includes(keyword));
    if (!asset) throw new Error(`bore: 지원하지 않는 플랫폼 (${platform}-${arch})`);

    const resp = await axios.get(asset.browser_download_url, {
      responseType: 'arraybuffer', maxRedirects: 10, timeout: 30000,
    });

    const ext = asset.name.endsWith('.zip') ? 'zip' : 'tar.gz';
    const tmp = path.join(os.tmpdir(), `bore-dl.${ext}`);
    await fs.writeFile(tmp, resp.data);

    await fs.ensureDir(path.dirname(bin));
    if (ext === 'zip') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${tmp}' -DestinationPath '${path.dirname(bin)}' -Force"`,
        { stdio: 'ignore', timeout: 60000 }
      );
    } else {
      execSync(`tar -xzf "${tmp}" -C "${path.dirname(bin)}"`, { stdio: 'ignore', timeout: 60000 });
    }
    await fs.remove(tmp);

    if (!await fs.pathExists(bin)) throw new Error('bore 압축 해제 실패');
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);

    this.onLog('[DevKit] bore 설치 완료 ✓');
    return bin;
  }

  async start() {
    if (this.process) throw new Error('bore가 이미 실행 중입니다.');
    this._stopped = false;
    clearTimeout(this._restartTimer);

    const bin = await this._ensureInstalled();
    this.onLog('[DevKit] bore 터널 시작 중...');

    this.process = spawn(bin, ['local', '25565', '--to', 'bore.pub'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      this.process = null;
      this.onLog(`[DevKit] bore 오류: ${err.message}`);
    });

    const parse = (line) => {
      // "listening at bore.pub:PORT"
      const m = line.match(/listening at (bore\.pub:\d+)/i);
      if (m) {
        this.address = m[1];
        this.onLog(`[DevKit] bore 터널 주소: ${this.address}`);
        this.onTunnelReady(this.address);
        return;
      }
      if (line.trim()) this.onLog(`[bore] ${line}`);
    };

    const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
    const handle = (data) => {
      data.toString().split('\n').map(stripAnsi).filter(l => l.trim()).forEach(parse);
    };

    this.process.stdout.on('data', handle);
    this.process.stderr.on('data', handle);

    this.process.on('exit', (code) => {
      const hadAddr = !!this.address;
      this.process = null;
      this.address = null;
      if (!this._stopped) {
        this.onLog(`[DevKit] bore 연결 끊김 (exit: ${code}) — 5초 후 재시작...`);
        this._restartTimer = setTimeout(() => {
          if (!this._stopped) this.start().catch(e => this.onLog(`[DevKit] bore 재시작 실패: ${e.message}`));
        }, 5000);
      } else if (hadAddr || code) {
        this.onLog(`[DevKit] bore 중지됨`);
      }
    });
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._restartTimer);
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.address = null;
    this.onLog('[DevKit] bore 중지됨');
  }

  getAddress() { return this.address; }
  isRunning()  { return !!this.process; }
}

module.exports = NgrokManager;
