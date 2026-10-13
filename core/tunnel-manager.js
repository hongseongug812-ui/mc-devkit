'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const axios = require('axios');
const {writeJsonAtomic}=require('./pack-utils');

const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

class TunnelManager {
  constructor(port, onLog, onTunnelReady) {
    this.port = port;           // DevKit 웹 대시보드 포트 (3847)
    this.onLog = onLog;
    this.onTunnelReady = onTunnelReady;   // (url) => void
    this.process = null;
    this.tunnelUrl = null;
    this.settingsFile=path.join(process.env.DEVKIT_DATA_DIR || path.join(os.homedir(),'.mc-devkit'),'tunnel.json');
    this.settings=fs.readJsonSync(this.settingsFile,{throws:false}) || {mode:'quick',origin:''};
  }

  getSettings(){const {token,...settings}=this.settings;return {...settings,hasToken:!!token};}
  async configure(input){
    if(this.process || this.tunnelUrl)throw Error('터널을 중지한 뒤 설정을 변경하세요.');
    if(!['quick','named','external'].includes(input.mode))throw Error('공유 방식이 잘못됐습니다.');
    let origin='';
    if(input.mode!=='quick'){
      const url=new URL(input.origin);
      if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('고정 공유 주소는 HTTPS 기본 주소를 입력하세요.');
      origin=url.origin;
    }
    const token=input.clearToken?'':input.token || this.settings.token || '';
    if(typeof token!=='string' || token.length>8192 || (token && !/^[A-Za-z0-9+/=_-]+$/.test(token)))throw Error('Cloudflare 터널 토큰을 확인하세요.');
    if(input.mode==='named' && !token)throw Error('고정 터널에는 Cloudflare에서 발급한 터널 토큰이 필요합니다.');
    this.settings={mode:input.mode,origin,token};await writeJsonAtomic(this.settingsFile,this.settings);return this.getSettings();
  }

  // ── cloudflared 바이너리 경로 ────────────────────────────────────────────────
  _binaryPath() {
    const dir = process.env.DEVKIT_DATA_DIR || path.join(os.homedir(), '.mc-devkit');
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
    if (this.process || this.tunnelUrl) throw new Error('터널이 이미 실행 중입니다.');
    if(this.settings.mode==='external'){
      this.tunnelUrl=this.settings.origin;this.onTunnelReady(this.tunnelUrl);return;
    }

    const binPath = await this._ensureInstalled();
    this.onLog(`[DevKit] 터널 생성 중 (포트 ${this.port})...`);

    const named=this.settings.mode==='named';
    const args=named?['tunnel','--no-autoupdate','run']:['tunnel','--url',`http://localhost:${this.port}`];
    const child=spawn(binPath,args,{windowsHide:true,env:{...process.env,...(named?{TUNNEL_TOKEN:this.settings.token}:{})}});
    this.process=child;

    // cloudflared는 URL을 stderr로 출력
    this.process.on('error', (err) => {
      if(this.process===child)this.process = null;
      this.tunnelUrl=null;this.onTunnelReady(null);
      this.onLog(`[DevKit] cloudflared 실행 오류: ${err.message}`);
    });

    this.process.stderr.on('data', (data) => {
      const text = data.toString();
      if(named && /Registered tunnel connection/.test(text) && !this.tunnelUrl){this.tunnelUrl=this.settings.origin;this.onTunnelReady(this.tunnelUrl);}

      // 터널 URL 파싱
      const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
      if (!named && match && !this.tunnelUrl) {
        this.tunnelUrl = match[0];
        this.onLog(`[DevKit] 터널 URL: ${this.tunnelUrl}`);
        this.onTunnelReady(this.tunnelUrl);
      }
    });

    this.process.on('exit', (code) => {
      if(this.process!==child)return;
      this.process = null;
      this.tunnelUrl = null;
      this.onTunnelReady(null);
      if (code !== 0) this.onLog(`[DevKit] 터널 종료 (exit: ${code})`);
    });
  }

  // ── 터널 중지 ───────────────────────────────────────────────────────────────
  stop() {
    this.process?.kill();
    this.process = null;
    this.tunnelUrl = null;
    this.onTunnelReady(null);
    this.onLog('[DevKit] 터널 중지됨');
  }

  getUrl() {
    return this.tunnelUrl;
  }
}

module.exports = TunnelManager;
