'use strict';

const net = require('net');

// RCON 패킷 타입
const RCON_AUTH = 3;
const RCON_COMMAND = 2;

class RconClient {
  constructor(host = '127.0.0.1', port = 25575, password = '') {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this._reqId = 1;
    this._pending = new Map();   // reqId → { resolve, reject }
    this._buf = Buffer.alloc(0);
  }

  // ── 연결 + 인증 ─────────────────────────────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });

      this.socket.on('connect', () => {
        this.connected = true;
        this._send(RCON_AUTH, this.password)
          .then(() => { this.authenticated = true; resolve(); })
          .catch(reject);
      });

      this.socket.on('data', (data) => this._onData(data));

      this.socket.on('error', (err) => {
        this.connected = false;
        reject(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.authenticated = false;
      });
    });
  }

  // ── 명령어 전송 ─────────────────────────────────────────────────────────────
  send(command) {
    if (!this.authenticated) throw new Error('RCON 인증되지 않음');
    return this._send(RCON_COMMAND, command);
  }

  // ── 연결 해제 ───────────────────────────────────────────────────────────────
  disconnect() {
    this.socket?.destroy();
    this.connected = false;
    this.authenticated = false;
  }

  // ── 자동 재연결 래퍼 ────────────────────────────────────────────────────────
  async sendSafe(command, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        if (!this.connected) await this.connect();
        return await this.send(command);
      } catch (err) {
        this.disconnect();
        if (i === retries - 1) throw err;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  // ── 내부: 패킷 빌드 + 전송 (5초 타임아웃) ────────────────────────────────────
  _send(type, payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = this._reqId++;
      const payloadBuf = Buffer.from(payload, 'utf8');
      const pktLen = 4 + 4 + payloadBuf.length + 2;
      const buf = Buffer.alloc(4 + pktLen);

      buf.writeInt32LE(pktLen, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      payloadBuf.copy(buf, 12);
      buf.writeUInt8(0, 12 + payloadBuf.length);
      buf.writeUInt8(0, 13 + payloadBuf.length);

      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('RCON 응답 타임아웃'));
        }
      }, timeoutMs);

      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(buf);
    });
  }

  // ── 내부: 수신 데이터 파싱 ──────────────────────────────────────────────────
  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);

    while (this._buf.length >= 4) {
      const pktLen = this._buf.readInt32LE(0);
      if (this._buf.length < 4 + pktLen) break;  // 아직 데이터 부족

      const id = this._buf.readInt32LE(4);
      const payload = this._buf.slice(12, 4 + pktLen - 2).toString('utf8');

      this._buf = this._buf.slice(4 + pktLen);

      const pending = this._pending.get(id);
      if (pending) {
        this._pending.delete(id);
        // auth 실패 시 서버가 -1 id로 응답
        id === -1
          ? pending.reject(new Error('RCON 인증 실패 — 비밀번호 확인'))
          : pending.resolve(payload);
      }
    }
  }
}

module.exports = RconClient;
