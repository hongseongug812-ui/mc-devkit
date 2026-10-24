'use strict';

// Only public profile and device-code state crosses the desktop bridge.
(() => {
  const bridge = window.devkit;
  const available = !!bridge && typeof bridge.accountStatus === 'function';
  const node = id => document.getElementById(`mcAccount${id}`);
  let status = { configured: false, clientId: '', account: null, pending: null, busy: false };
  let loading = available, working = false, launching = false, localError = '', clientIdDirty = false;

  function errorMessage(error) {
    return String(error?.message || error || '계정 연결에 실패했습니다.')
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }

  function expiresAt() {
    const value = status.pending?.expiresAt;
    return typeof value === 'number' ? value : Date.parse(value || '');
  }

  function expired() {
    const time = expiresAt();
    return Number.isFinite(time) && time <= Date.now();
  }

  function verificationUrl() {
    try {
      const url = new URL(status.pending?.verificationUri);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      if (host !== 'microsoft.com' && !host.endsWith('.microsoft.com') && host !== 'login.microsoftonline.com' && host !== 'login.live.com') return null;
      return url.href;
    } catch { return null; }
  }

  function canPlay() {
    return available && !loading && !working && !status.busy && !status.pending && !!status.account;
  }

  function renderPending() {
    node('Pending').hidden = !status.pending;
    node('Code').textContent = status.pending?.userCode || '';
    node('Copy').disabled = !status.pending || expired();
    node('Open').disabled = !status.pending || expired() || !verificationUrl();
    if (!status.pending) return;
    const remaining = Math.max(0, Math.ceil((expiresAt() - Date.now()) / 1000));
    node('Expiry').textContent = expired()
      ? '코드가 만료됐습니다. 새 코드로 다시 연결하세요.'
      : Number.isFinite(remaining)
        ? `남은 시간 ${Math.floor(remaining / 60)}분 ${String(remaining % 60).padStart(2, '0')}초 · 로그인 후 자동으로 연결됩니다.`
        : 'Microsoft 로그인을 마치면 자동으로 연결됩니다.';
  }

  function render() {
    const pending = !!status.pending;
    const waiting = pending && !expired();
    const busy = loading || working || launching || status.busy && !expired();
    const linked = !!status.account;
    node('Badge').textContent = !available ? '앱 전용' : linked ? '연결됨' : waiting ? '로그인 대기' : busy ? '연결 확인 중' : '연결 안 됨';
    node('Badge').classList.toggle('linked', linked);
    node('Summary').textContent = !available
      ? bridge ? '계정 연결을 사용하려면 MC DevKit 앱을 최신 버전으로 업데이트하세요.' : '계정 연결과 게임 실행은 설치된 MC DevKit 앱에서 사용할 수 있습니다.'
      : linked ? `${status.account.name} · Minecraft Java Edition 계정으로 게임을 실행합니다.${status.account.persistent === false ? ' 앱을 다시 열면 계정을 다시 연결하세요.' : ''}`
        : waiting ? 'Microsoft 계정 로그인을 기다리고 있습니다.'
          : busy ? '계정 연결을 확인하고 있습니다…'
            : status.configured ? 'Microsoft 계정을 연결하면 참가 서버에서 바로 게임을 실행할 수 있습니다.' : '참가자 직접 게임 실행을 사용하려면 아래에서 Microsoft 로그인 앱을 설정하세요.';
    node('Login').hidden = linked;
    node('Login').disabled = !available || busy || waiting || !status.configured;
    node('Login').textContent = pending && expired() ? '새 코드로 다시 연결' : 'Microsoft 계정 연결';
    node('Logout').hidden = !linked;
    node('Logout').disabled = !available || busy || pending;
    node('Cancel').hidden = !available || !pending && !status.busy;
    node('Cancel').disabled = working || loading;
    node('Setup').hidden = !available;
    if (!clientIdDirty && document.activeElement !== node('ClientId')) node('ClientId').value = status.clientId || '';
    node('ClientId').disabled = !available || busy || pending || linked;
    node('Save').disabled = !available || busy || pending || linked;
    node('Error').textContent = localError || status.error || '';
    node('Error').hidden = !node('Error').textContent;
    renderPending();
  }

  function announce() {
    window.dispatchEvent(new CustomEvent('mc-account-changed', { detail: { ...status, loading, working, available } }));
  }

  function applyStatus(value) {
    if (value && typeof value === 'object' && 'configured' in value) {
      if (value.account && !status.account) node('Setup').open = false;
      status = value;
    }
    loading = false;
    render();
    announce();
  }

  async function refresh() {
    if (!available) return;
    try { applyStatus(await bridge.accountStatus()); }
    catch (error) { loading = false; localError = errorMessage(error); render(); announce(); }
  }

  async function action(callback) {
    if (!available || working || loading) return;
    working = true;
    localError = '';
    node('Notice').textContent = '';
    render();
    announce();
    try {
      const value = await callback();
      if (value && typeof value === 'object' && 'configured' in value) applyStatus(value);
      else await refresh();
    } catch (error) {
      localError = errorMessage(error);
      await refresh();
    } finally { working = false; render(); announce(); }
  }

  function focus() {
    node('Card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    node('Card').focus({ preventScroll: true });
    if (available && !status.configured) {
      node('Setup').open = true;
      node('ClientId').focus({ preventScroll: true });
    } else if (!node('Login').disabled && !node('Login').hidden) node('Login').focus({ preventScroll: true });
  }

  async function login() {
    if (!available || !status.configured || status.account || status.pending && !expired() || status.busy && !expired()) return;
    await action(async () => {
      if (status.pending) await bridge.accountCancel();
      return bridge.accountLogin();
    });
  }

  node('Login').addEventListener('click', login);
  node('Logout').addEventListener('click', () => action(() => bridge.accountLogout()));
  node('Cancel').addEventListener('click', () => action(() => bridge.accountCancel()));
  node('ClientId').addEventListener('input', () => { clientIdDirty = true; });
  node('Save').addEventListener('click', () => {
    const clientId = node('ClientId').value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      localError = '올바른 Microsoft 애플리케이션 클라이언트 ID를 입력하세요.';
      render();
      node('ClientId').focus();
      return;
    }
    action(async () => { const value = await bridge.accountConfigure(clientId); clientIdDirty = false; node('Setup').open = false; return value; });
  });
  node('Copy').addEventListener('click', async () => {
    if (!status.pending || expired()) return;
    try { await navigator.clipboard.writeText(status.pending.userCode); node('Notice').textContent = '로그인 코드를 복사했습니다.'; }
    catch { localError = '코드 복사에 실패했습니다. 표시된 코드를 직접 입력하세요.'; render(); }
  });
  node('Open').addEventListener('click', async () => {
    const url = verificationUrl();
    if (!url || expired()) return;
    try { await bridge.openExternal(url); }
    catch (error) { localError = errorMessage(error); render(); }
  });

  window.mcAccount = { getState: () => ({ ...status, loading, working, available }), canPlay, focus, login, refresh };
  window.addEventListener('mc-launch-state', event => { launching = !!event.detail?.busy; render(); });
  if (available && typeof bridge.onAccountChanged === 'function') bridge.onAccountChanged(value => { localError = ''; applyStatus(value); });
  render();
  refresh();
  let wasExpired = false;
  setInterval(() => {
    if (!status.pending) { wasExpired = false; return; }
    const isExpired = expired();
    if (isExpired !== wasExpired) { wasExpired = isExpired; render(); announce(); }
    else renderPending();
  }, 1000);
})();
