'use strict';

const { v4: uuidv4 } = require('uuid');

// 기본 권한 (런타임에서 변경 가능)
const DEFAULT_ROLES = {
  OWNER:  ['start','stop','restart','reload','build','command','kick'],
  ADMIN:  ['restart','reload','build','command'],
  MEMBER: ['reload','build'],
  VIEWER: [],
};

class TeamManager {
  constructor(wss, handlers) {
    this.wss        = wss;
    this.handlers   = handlers;
    this.clients    = new Map();   // token → { ws, name, role }
    this.ownerToken = uuidv4();
    this.roles      = JSON.parse(JSON.stringify(DEFAULT_ROLES));  // 복사본

    wss.on('connection', (ws, req) => this._onConnect(ws, req));
    console.log(`[DevKit] Owner 토큰: ${this.ownerToken}`);
  }

  // ── 연결 ────────────────────────────────────────────────────────────────────
  _onConnect(ws) {
    let token = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (!token && msg.type !== 'AUTH') {
          ws.send(JSON.stringify({ type:'ERROR', message:'먼저 인증하세요.' }));
          return;
        }
        switch (msg.type) {
          case 'AUTH':        token = this._handleAuth(ws, msg);       break;
          case 'ACTION':      this._handleAction(token, msg);          break;
          case 'COMMAND':     this._handleCommand(token, msg);         break;
          case 'STDIN':       this._handleStdin(token, msg);           break;
          case 'ROLE_CHANGE': this._handleRoleChange(token, msg);      break;
          case 'KICK':        this._handleKick(token, msg);            break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type:'ERROR', message: err.message }));
      }
    });

    ws.on('close', () => {
      if (token) {
        this.clients.delete(token);
        this.broadcast({ type:'TEAM_UPDATE', clients: this._clientList() });
      }
    });
  }

  // ── 인증 ────────────────────────────────────────────────────────────────────
  _handleAuth(ws, msg) {
    const { name, token: provided } = msg;
    let role  = 'MEMBER';
    let token = provided || uuidv4();

    if (provided === this.ownerToken) {
      role  = 'OWNER';
      token = provided;
    } else if (!provided) {
      role  = 'MEMBER';
      token = uuidv4();
    }

    this.clients.set(token, { ws, name: name || `User_${token.slice(0,4)}`, role });
    ws.send(JSON.stringify({ type:'AUTH_OK', token, role, name,
      permissions: this._publicPermissions() }));
    this.broadcast({ type:'TEAM_UPDATE', clients: this._clientList() });
    return token;
  }

  // ── 액션 (권한 체크) ─────────────────────────────────────────────────────────
  async _handleAction(token, msg) {
    const client  = this.clients.get(token);
    if (!client) return;
    const allowed = this.roles[client.role] || [];
    if (!allowed.includes(msg.action)) {
      client.ws.send(JSON.stringify({ type:'ERROR',
        message:`권한 없음: ${client.role}은 '${msg.action}' 불가` }));
      return;
    }
    this.broadcast({ type:'ACTION_LOG',
      message:`${client.name}이(가) [${msg.action}] 실행`, by: client.name, action: msg.action });
    try {
      switch (msg.action) {
        case 'start':   await this.handlers.onStart();   break;
        case 'stop':    await this.handlers.onStop();    break;
        case 'restart': await this.handlers.onRestart(); break;
        case 'build':   await this.handlers.onBuild();   break;
        case 'reload':  await this.handlers.onReload();  break;
      }
    } catch (err) {
      this.broadcast({ type:'ERROR', message: err.message });
    }
  }

  // ── RCON 명령어 ──────────────────────────────────────────────────────────────
  async _handleCommand(token, msg) {
    const client = this.clients.get(token);
    if (!client) return;
    if (!(this.roles[client.role] || []).includes('command')) {
      client.ws.send(JSON.stringify({ type:'ERROR', message:'명령어 권한 없음' }));
      return;
    }
    try {
      const result = await this.handlers.onCommand(msg.command);
      this.broadcast({ type:'COMMAND_RESULT', command: msg.command, result, by: client.name });
    } catch (err) {
      client.ws.send(JSON.stringify({ type:'ERROR', message: err.message }));
    }
  }

  // ── 서버 콘솔 직접 stdin (OWNER/ADMIN 전용) ─────────────────────────────────
  _handleStdin(token, msg) {
    const client = this.clients.get(token);
    if (!client) return;
    if (!['OWNER','ADMIN'].includes(client.role)) {
      client.ws.send(JSON.stringify({ type:'ERROR', message:'stdin 권한 없음' }));
      return;
    }
    try {
      this.handlers.onStdin(msg.input);
      this.broadcast({ type:'ACTION_LOG', message:`${client.name}이(가) 콘솔 입력: ${msg.input}` });
    } catch (err) {
      client.ws.send(JSON.stringify({ type:'ERROR', message: err.message }));
    }
  }

  // ── 역할 변경 (OWNER 전용) ───────────────────────────────────────────────────
  _handleRoleChange(token, msg) {
    const me = this.clients.get(token);
    if (!me || me.role !== 'OWNER') return;

    const target = this.clients.get(msg.targetToken);
    if (!target || target.role === 'OWNER') return;

    const valid = ['ADMIN','MEMBER','VIEWER'];
    if (!valid.includes(msg.newRole)) return;

    target.role = msg.newRole;
    target.ws.send(JSON.stringify({ type:'AUTH_OK', token: msg.targetToken,
      role: msg.newRole, name: target.name,
      permissions: this._publicPermissions() }));
    this.broadcast({ type:'TEAM_UPDATE', clients: this._clientList() });
    this.broadcast({ type:'ACTION_LOG',
      message:`${me.name}이(가) ${target.name}의 권한을 ${msg.newRole}로 변경` });
  }

  // ── 강퇴 (OWNER 전용) ────────────────────────────────────────────────────────
  _handleKick(token, msg) {
    const me = this.clients.get(token);
    if (!me || me.role !== 'OWNER') return;

    const target = this.clients.get(msg.targetToken);
    if (!target || target.role === 'OWNER') return;

    target.ws.send(JSON.stringify({ type:'KICKED', message:'관리자에 의해 강퇴되었습니다.' }));
    target.ws.terminate();
    this.clients.delete(msg.targetToken);
    this.broadcast({ type:'TEAM_UPDATE', clients: this._clientList() });
    this.broadcast({ type:'ACTION_LOG', message:`${me.name}이(가) ${target.name}을(를) 강퇴` });
  }

  // ── 권한 설정 변경 (OWNER 전용) ──────────────────────────────────────────────
  setPermissions(perms) {
    // OWNER 권한은 항상 고정
    ['ADMIN','MEMBER','VIEWER'].forEach(role => {
      if (perms[role]) this.roles[role] = perms[role];
    });
    // 접속 중인 팀원들에게 갱신된 권한 + 버튼 상태 동기화
    for (const [tok, client] of this.clients) {
      client.ws.send(JSON.stringify({ type:'AUTH_OK', token: tok,
        role: client.role, name: client.name,
        permissions: this._publicPermissions() }));
    }
    this.broadcast({ type:'ACTION_LOG', message:'권한 설정이 변경되었습니다.' });
  }

  getPermissions() { return this._publicPermissions(); }

  // ── 내부 헬퍼 ────────────────────────────────────────────────────────────────
  _publicPermissions() {
    return { ADMIN: this.roles.ADMIN, MEMBER: this.roles.MEMBER, VIEWER: this.roles.VIEWER };
  }

  _clientList() {
    return Array.from(this.clients.entries()).map(([tok, { name, role }]) =>
      ({ name, role, id: tok }));
  }

  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const { ws } of this.clients.values())
      if (ws.readyState === 1) ws.send(payload);
  }

  broadcastLog(line)              { this.broadcast({ type:'LOG', line }); }
  broadcastStatus(status, url)    { this.broadcast({ type:'STATUS', status, tunnelUrl: url }); }
  getOwnerToken()                 { return this.ownerToken; }
}

module.exports = TeamManager;
