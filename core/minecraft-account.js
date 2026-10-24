'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('node:crypto');
const axios = require('axios');

const OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';
const CLIENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MESSAGES = {
  configuration: 'Microsoft 앱의 올바른 클라이언트 ID를 먼저 설정해 주세요.',
  cancelled: '계정 연결이 취소되었습니다.',
  expired: '로그인 코드가 만료되었습니다. 다시 연결해 주세요.',
  declined: 'Microsoft 로그인이 거절되었습니다. 다시 연결해 주세요.',
  oauth: 'Microsoft 로그인에 실패했습니다. 앱 등록과 공개 클라이언트 설정을 확인해 주세요.',
  refresh: 'Microsoft 로그인이 만료되었거나 취소되었습니다. 계정을 다시 연결해 주세요.',
  xbox: 'Xbox 계정을 확인할 수 없습니다. Xbox 프로필과 계정의 가족 설정을 확인해 주세요.',
  minecraft: 'Minecraft 인증에 실패했습니다. 앱의 Minecraft API 접근 승인 상태를 확인해 주세요.',
  ownership: '이 계정에서 Minecraft Java Edition 이용 권한을 확인할 수 없습니다.',
  profile: 'Minecraft Java 프로필을 확인할 수 없습니다. 공식 런처에서 프로필을 먼저 만들어 주세요.',
  network: '계정 서버에 연결할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.',
  storage: '계정 정보를 안전하게 저장할 수 없습니다. 계정을 다시 연결해 주세요.',
  noAccount: 'Minecraft 계정을 먼저 연결해 주세요.',
  busy: '계정 확인이 진행 중입니다. 잠시 후 다시 시도해 주세요.',
  closed: '계정 서비스가 종료되었습니다.',
};

// Deliberately never retain an HTTP error, its request headers, or server text.
class AccountError extends Error {
  constructor(code, oauthCode = '') {
    super(MESSAGES[code] || MESSAGES.network);
    this.name = 'MinecraftAccountError';
    this.code = code;
    if (oauthCode) this.oauthCode = oauthCode;
  }
}

function secret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 * 1024;
}
function publicAccount(profile, persistent = false) {
  if (!profile || !/^[a-f0-9]{32}$/i.test(profile.id || '') || !/^[a-z0-9_]{1,16}$/i.test(profile.name || '')) {
    throw new AccountError('profile');
  }
  return { id: profile.id.toLowerCase(), name: profile.name, persistent: !!persistent };
}
function verificationUri(raw) {
  try {
    const uri = new URL(raw);
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.port ||
        !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com'].includes(uri.hostname)) throw Error();
    return uri.href;
  } catch { throw new AccountError('oauth'); }
}

/** Main-process only. Never expose getSession() or this object through IPC. */
class MinecraftAccount {
  constructor(root, {
    secureStorage,
    clientId = process.env.DEVKIT_MICROSOFT_CLIENT_ID || require('../package.json').minecraftClientId || '',
    request = axios,
    onChange = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    requestTimeoutMs = 15000,
  } = {}) {
    this.file = path.join(path.resolve(root), 'minecraft-account.json');
    this.secureStorage = secureStorage;
    this.clientId = typeof clientId === 'string' ? clientId.trim() : '';
    this._explicitClientId = !!this.clientId;
    this._request = typeof request === 'function' ? request : config => request.request(config);
    this._onChange = onChange;
    this._now = now;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._timeout = Math.max(1000, Math.min(30000, Number(requestTimeoutMs) || 15000));
    this._account = null;
    this._refreshToken = null;
    this._session = null;
    this._pending = null;
    this._busy = false;
    this._error = '';
    this._generation = 0;
    this._controller = null;
    this._closed = false;
    this._diskQueue = Promise.resolve();
    this._initPromise = null;
    this._sessionPromise = null;
  }

  status() {
    return {
      configured: CLIENT_ID.test(this.clientId),
      clientId: this.clientId,
      account: this._account ? { ...this._account } : null,
      pending: this._pending ? { ...this._pending } : null,
      busy: this._busy,
      ...(this._error ? { error: this._error } : {}),
    };
  }

  _emit() {
    try { this._onChange(this.status()); } catch { /* UI observers cannot break authentication. */ }
  }
  _live(generation) {
    if (this._closed || generation !== this._generation) throw new AccountError('cancelled');
  }
  _requireOpen() {
    if (this._closed) throw new AccountError('closed');
  }
  _canEncrypt() {
    try {
      return !!this.secureStorage?.isEncryptionAvailable() &&
        this.secureStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  init() {
    if (!this._initPromise) this._initPromise = this._load();
    return this._initPromise;
  }
  async _load() {
    this._requireOpen();
    const generation = this._generation;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new AccountError('storage');
      const saved = await fs.readJson(this.file);
      this._live(generation);
      if (saved.version !== 1) throw new AccountError('storage');
      if (!this._explicitClientId && CLIENT_ID.test(saved.clientId || '')) this.clientId = saved.clientId;
      if (saved.clientId !== this.clientId || !saved.encryptedRefreshToken) return this.status();
      if (!this._canEncrypt() || typeof saved.encryptedRefreshToken !== 'string' ||
          !/^[a-z0-9+/]+={0,2}$/i.test(saved.encryptedRefreshToken) || saved.encryptedRefreshToken.length > 192 * 1024) {
        throw new AccountError('storage');
      }
      const token = this.secureStorage.decryptString(Buffer.from(saved.encryptedRefreshToken, 'base64'));
      if (!secret(token)) throw new AccountError('storage');
      const account = publicAccount(saved.account, true);
      this._live(generation);
      this._refreshToken = token;
      this._account = account;
    } catch (error) {
      if (generation !== this._generation || this._closed) return this.status();
      if (error.code !== 'ENOENT') this._error = MESSAGES.storage;
    }
    this._emit();
    return this.status();
  }

  _invalidate() {
    this._generation++;
    this._controller?.abort();
    this._controller = null;
    this._pending = null;
    this._busy = false;
    this._sessionPromise = null;
    return this._generation;
  }

  async configure(clientId) {
    this._requireOpen();
    await this.init();
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId.trim())) throw new AccountError('configuration');
    const generation = this._invalidate();
    this.clientId = clientId.trim();
    this._explicitClientId = true;
    this._account = this._refreshToken = this._session = null;
    this._error = '';
    try { await this._persist(generation); } catch { this._error = MESSAGES.storage; }
    this._emit();
    return this.status();
  }

  async _http(url, { data, form, token, stage = 'network', generation, signal } = {}) {
    this._live(generation);
    try {
      const response = await this._request({
        url,
        method: data || form ? 'POST' : 'GET',
        data: form ? new URLSearchParams(form).toString() : data,
        headers: {
          Accept: 'application/json',
          ...(data || form ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: this._timeout,
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
        signal,
      });
      this._live(generation);
      if (!response || response.status < 200 || response.status >= 300 || !response.data || typeof response.data !== 'object') throw new AccountError(stage);
      return response.data;
    } catch (error) {
      this._live(generation);
      if (error instanceof AccountError) throw error;
      const oauthCode = error.response?.data?.error;
      if (['authorization_pending', 'slow_down', 'authorization_declined', 'access_denied', 'expired_token', 'invalid_grant'].includes(oauthCode)) {
        throw new AccountError(stage, oauthCode);
      }
      throw new AccountError(error.response ? stage : 'network');
    }
  }

  async beginLogin() {
    this._requireOpen();
    await this.init();
    this._requireOpen();
    if (!CLIENT_ID.test(this.clientId)) throw new AccountError('configuration');
    const generation = this._invalidate();
    const controller = this._controller = new AbortController();
    this._busy = true;
    this._error = '';
    this._emit();
    try {
      const code = await this._http(`${OAUTH}/devicecode`, {
        form: { client_id: this.clientId, scope: SCOPE }, stage: 'oauth', generation, signal: controller.signal,
      });
      if (!secret(code.device_code) || !/^[a-z0-9-]{4,32}$/i.test(code.user_code || '') ||
          !Number.isFinite(code.expires_in) || code.expires_in <= 0 || code.expires_in > 1800) throw new AccountError('oauth');
      this._pending = {
        userCode: code.user_code,
        verificationUri: verificationUri(code.verification_uri),
        expiresAt: this._now() + code.expires_in * 1000,
      };
      const expiresAt = this._pending.expiresAt;
      const interval = Math.max(1, Number.isFinite(code.interval) ? code.interval : 5) * 1000;
      this._emit();
      // Device codes and tokens remain only in the closure, outside public status.
      void this._poll(code.device_code, interval, expiresAt, generation, controller.signal);
      return this.status();
    } catch (error) {
      if (generation !== this._generation || this._closed) return this.status();
      this._finishFailure(error, generation);
      throw new AccountError(error instanceof AccountError ? error.code : 'network');
    }
  }

  _delay(ms, signal) {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      let timer;
      const finish = () => { this._clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      timer = this._setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  async _poll(deviceCode, interval, expiresAt, generation, signal) {
    try {
      while (this._now() < expiresAt) {
        await this._delay(Math.min(interval, expiresAt - this._now()), signal);
        this._live(generation);
        if (this._now() >= expiresAt) break;
        let microsoft;
        try {
          microsoft = await this._http(`${OAUTH}/token`, {
            form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: this.clientId, device_code: deviceCode },
            stage: 'oauth', generation, signal,
          });
        } catch (error) {
          if (error.oauthCode === 'authorization_pending') continue;
          if (error.oauthCode === 'slow_down') { interval += 5000; continue; }
          if (['authorization_declined', 'access_denied'].includes(error.oauthCode)) throw new AccountError('declined');
          if (error.oauthCode === 'expired_token') throw new AccountError('expired');
          throw error;
        }
        const verified = await this._exchange(microsoft, generation, signal);
        await this._accept(verified, generation);
        this._live(generation);
        this._pending = null;
        this._busy = false;
        this._controller = null;
        this._emit();
        return;
      }
      throw new AccountError('expired');
    } catch (error) { this._finishFailure(error, generation); }
  }

  async _exchange(microsoft, generation, signal, previousRefreshToken = null) {
    if (!secret(microsoft.access_token)) throw new AccountError('oauth');
    const opts = { generation, signal };
    const xbox = await this._http('https://user.auth.xboxlive.com/user/authenticate', {
      ...opts, stage: 'xbox', data: {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoft.access_token}` },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
      },
    });
    if (!secret(xbox.Token)) throw new AccountError('xbox');
    const xsts = await this._http('https://xsts.auth.xboxlive.com/xsts/authorize', {
      ...opts, stage: 'xbox', data: {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
      },
    });
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!secret(xsts.Token) || typeof uhs !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(uhs)) throw new AccountError('xbox');
    const minecraft = await this._http('https://api.minecraftservices.com/authentication/login_with_xbox', {
      ...opts, stage: 'minecraft', data: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` },
    });
    if (!secret(minecraft.access_token) || !Number.isFinite(minecraft.expires_in) || minecraft.expires_in <= 0) throw new AccountError('minecraft');
    const entitlement = await this._http('https://api.minecraftservices.com/entitlements/mcstore', {
      ...opts, stage: 'ownership', token: minecraft.access_token,
    });
    if (!Array.isArray(entitlement.items) || !entitlement.items.some(item => ['game_minecraft', 'product_minecraft'].includes(item?.name))) {
      throw new AccountError('ownership');
    }
    const profile = await this._http('https://api.minecraftservices.com/minecraft/profile', {
      ...opts, stage: 'profile', token: minecraft.access_token,
    });
    const account = publicAccount(profile);
    return {
      account,
      refreshToken: secret(microsoft.refresh_token) ? microsoft.refresh_token : previousRefreshToken,
      session: {
        accessToken: minecraft.access_token, uuid: account.id, name: account.name, userType: 'msa',
        expiresAt: this._now() + Math.min(minecraft.expires_in, 86400) * 1000,
        clientId: this.clientId, xuid: typeof xsts.DisplayClaims?.xui?.[0]?.xid === 'string' ? xsts.DisplayClaims.xui[0].xid : '',
      },
    };
  }

  async _accept(verified, generation) {
    this._live(generation);
    let persistent = false;
    try {
      persistent = await this._persist(generation, { account: verified.account, refreshToken: verified.refreshToken });
    } catch (error) {
      this._live(generation);
      // A verified login remains usable in memory if the OS keychain is unavailable.
    }
    // Commit public identity and live credentials together, after all cancellable I/O.
    this._live(generation);
    this._account = { ...verified.account, persistent };
    this._refreshToken = verified.refreshToken;
    this._session = verified.session;
    this._error = '';
  }

  _persist(generation, { account = this._account, refreshToken = this._refreshToken } = {}) {
    const saved = { version: 1, clientId: this.clientId };
    let persistent = false;
    if (account && secret(refreshToken) && this._canEncrypt()) {
      try {
        const encrypted = this.secureStorage.encryptString(refreshToken);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw Error();
        saved.encryptedRefreshToken = encrypted.toString('base64');
        saved.account = { id: account.id, name: account.name };
        persistent = true;
      } catch {
        // Failed encryption must also remove a previously saved credential.
        delete saved.encryptedRefreshToken;
        delete saved.account;
        persistent = false;
      }
    }
    const contents = JSON.stringify(saved, null, 2);
    const work = async () => {
      this._live(generation);
      await fs.ensureDir(path.dirname(this.file));
      this._live(generation);
      const previous = await fs.readFile(this.file).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      this._live(generation);
      const temp = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        this._live(generation);
        await fs.rename(temp, this.file);
        // This queue owns the file until completion, including a cancellation
        // that arrives while rename is in flight. No later save can be removed.
        if (this._closed || generation !== this._generation) {
          if (previous) {
            await fs.writeFile(temp, previous, { mode: 0o600, flag: 'wx' });
            await fs.rename(temp, this.file);
          } else await fs.remove(this.file);
        }
        this._live(generation);
        return persistent;
      } finally { await fs.remove(temp).catch(() => {}); }
    };
    const result = this._diskQueue.then(work, work);
    this._diskQueue = result.catch(() => {});
    return result;
  }

  _finishFailure(error, generation) {
    if (generation !== this._generation || this._closed) return;
    this._pending = null;
    this._busy = false;
    this._controller = null;
    this._error = error instanceof AccountError ? error.message : MESSAGES.network;
    this._emit();
  }

  cancelLogin() {
    if (this._pending || (this._busy && !this._sessionPromise)) {
      this._invalidate();
      this._error = '';
      this._emit();
    }
    return this.status();
  }

  async logout() {
    this._requireOpen();
    await this.init();
    const generation = this._invalidate();
    this._account = this._refreshToken = this._session = null;
    this._error = '';
    try { await this._persist(generation); } catch { this._error = MESSAGES.storage; }
    this._emit();
    return this.status();
  }

  async getSession() {
    this._requireOpen();
    await this.init();
    this._requireOpen();
    if (this._sessionPromise) return this._sessionPromise;
    if (this._busy) throw new AccountError('busy');
    if (!this._account) throw new AccountError('noAccount');
    // A session-only login can launch until its access token expires.
    if (!this._refreshToken) {
      if (this._session?.expiresAt > this._now() + 60000) return { ...this._session };
      throw new AccountError('refresh');
    }
    const generation = this._generation;
    const controller = this._controller = new AbortController();
    this._busy = true;
    this._error = '';
    this._emit();
    const operation = (async () => {
      try {
        const microsoft = await this._http(`${OAUTH}/token`, {
          form: { client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this._refreshToken, scope: SCOPE },
          stage: 'refresh', generation, signal: controller.signal,
        });
        const verified = await this._exchange(microsoft, generation, controller.signal, this._refreshToken);
        // A refresh must never switch the saved Minecraft identity.
        if (verified.account.id !== this._account?.id) throw new AccountError('refresh');
        await this._accept(verified, generation);
        this._live(generation);
        this._busy = false;
        this._controller = null;
        this._emit();
        return { ...this._session };
      } catch (error) {
        this._finishFailure(error, generation);
        throw new AccountError(error instanceof AccountError ? error.code : 'network');
      } finally {
        if (generation === this._generation) this._sessionPromise = null;
      }
    })();
    this._sessionPromise = operation;
    return operation;
  }

  close() {
    this._invalidate();
    this._closed = true;
    this._account = this._refreshToken = this._session = null;
  }
}

module.exports = MinecraftAccount;
module.exports.MinecraftAccount = MinecraftAccount;
