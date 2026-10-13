'use strict';

let selectedPack = null;
let toastTimer;
function showToast(message, error = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, error ? 8000 : 4000);
}

async function loadPackPanel() {
  const status = document.getElementById('packStatus');
  if (myRole !== 'OWNER') {
    status.textContent = '호스트 앱에서 서버를 선택한 뒤 모드팩을 배포하세요.';
    document.getElementById('publishPackBtn').disabled = true;
    return;
  }
  document.getElementById('publishPackBtn').disabled = false;
  try {
    const response = await fetch(`/api/modpack?name=${encodeURIComponent(currentProfileName || '')}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    selectedPack = data;
    document.getElementById('packSource').value = data.sourceDir;
    document.getElementById('packPatterns').value = (data.patterns || ['*.jar']).join(', ');
    document.getElementById('packLoader').value = data.loader;
    document.getElementById('packLoader').disabled = !!data.manifest;
    document.getElementById('packAuto').checked = data.autoPublish || !data.manifest;
    document.getElementById('packVersion').textContent = `${data.name} · Minecraft ${data.minecraft}`;
    if (!document.getElementById('packBase').value || tunnelUrl) document.getElementById('packBase').value = tunnelUrl || '';
    renderPublishedPack(data.manifest);
  } catch (e) { status.textContent = e.message; }
}

function renderPublishedPack(manifest) {
  document.getElementById('packStatus').textContent = manifest
    ? `배포 ${manifest.revision.slice(0, 8)} · ${manifest.files.length}개 · ${new Date(manifest.publishedAt).toLocaleString()}`
    : '아직 배포되지 않았습니다. 배포 폴더에 모드를 넣고 배포 버튼을 누르세요.';
  const list = document.getElementById('packFiles');
  list.replaceChildren();
  for (const file of manifest?.files || []) {
    const row = document.createElement('div');
    row.className = 'pack-file-row';
    const name = document.createElement('span'), size = document.createElement('span');
    name.textContent = file.name;
    size.textContent = fmtSize(file.size);
    row.append(name, size);
    list.append(row);
  }
}

function useServerMods() {
  if (!selectedPack?.serverModsDir) return;
  document.getElementById('packSource').value = selectedPack.serverModsDir;
  document.getElementById('packPatterns').value = '';
  document.getElementById('packPatterns').focus();
  document.getElementById('packStatus').textContent = '참가자에게 배포할 공용 모드의 파일 규칙을 입력하세요. 이 폴더에서 모드를 교체하면 자동으로 배포됩니다.';
}

async function publishPack() {
  const button = document.getElementById('publishPackBtn');
  button.disabled = true;
  document.getElementById('packStatus').textContent = '모드 파일을 검증하고 배포하고 있습니다…';
  try {
    const response = await fetch('/api/modpack/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: currentProfileName, sourceDir: document.getElementById('packSource').value,
        patterns: document.getElementById('packPatterns').value.split(',').map(p => p.trim()).filter(Boolean),
        loader: document.getElementById('packLoader').value, autoPublish: document.getElementById('packAuto').checked }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    selectedPack = { ...selectedPack, ...data };
    renderPublishedPack(data.manifest);
    document.getElementById('packLoader').disabled = true;
    showToast('모드팩 배포 완료. 참가자가 자동으로 업데이트를 받습니다.');
  } catch (e) {
    document.getElementById('packStatus').textContent = e.message;
    showToast(e.message, true);
  } finally { button.disabled = false; }
}

async function copyPackInvite() {
  try {
    if (!selectedPack?.manifest) throw new Error('모드팩을 먼저 배포하세요.');
    const base = new URL(document.getElementById('packBase').value);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('공유 서버 주소를 확인하세요.');
    if (['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('외부 참가자는 로컬 주소로 연결할 수 없습니다. 공유 터널 주소를 사용하세요.');
    base.pathname = '/';
    base.search = new URLSearchParams({ join: selectedPack.id }).toString();
    base.hash = new URLSearchParams({ token: selectedPack.token }).toString();
    await navigator.clipboard.writeText(base.href);
    document.getElementById('packInviteStatus').textContent = '참가 링크를 복사했습니다. 팀원은 자신의 앱에서 ‘서버 참가’에 붙여넣으세요.';
    showToast('참가 링크를 복사했습니다.');
  } catch (e) {
    document.getElementById('packInviteStatus').textContent = e.message;
    showToast(e.message, true);
  }
}

function openJoinModal() {
  document.getElementById('joinModal').style.display = 'flex';
  document.getElementById('joinStatus').textContent = isElectron ? '' : '모드 자동 설치는 설치된 MC DevKit 앱에서 사용할 수 있습니다.';
  document.getElementById('joinBtn').disabled = !isElectron;
  document.getElementById('joinInvite').focus();
}
function closeJoinModal() { document.getElementById('joinModal').style.display = 'none'; }

async function joinPack() {
  const button = document.getElementById('joinBtn');
  button.disabled = true;
  document.getElementById('joinStatus').textContent = '이 서버용 게임 폴더를 선택하세요.';
  try {
    const rows = await window.devkit.syncJoin(document.getElementById('joinInvite').value.trim(), document.getElementById('joinLauncher').value);
    if (!rows) { document.getElementById('joinStatus').textContent = '폴더 선택을 취소했습니다.'; return; }
    renderSubscriptions(rows);
    closeJoinModal();
    showToast('참가 목록을 확인하세요. 앱이 실행되는 동안 자동으로 동기화됩니다.');
  } catch (e) {
    document.getElementById('joinStatus').textContent = e.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  } finally { button.disabled = false; }
}

const SYNC_LABELS = { current: '동기화 완료', updated: '업데이트 적용', waiting: '게임 종료 대기', error: '확인 필요', pending: '준비 중', syncing: '동기화 중' };
function renderSubscriptions(rows) {
  const grid = document.getElementById('syncGrid');
  grid.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '참가 중인 서버가 없습니다. 호스트의 참가 링크를 받아 게임 폴더를 연결하세요.';
    grid.append(empty);
  }
  for (const sub of rows) {
    const card = document.createElement('div');
    card.className = 'sync-card';
    const heading = document.createElement('h3'); heading.textContent = sub.name;
    const environment = document.createElement('div'); environment.className = 'subtle';
    environment.textContent = `Minecraft ${sub.minecraft} · ${sub.loader === 'none' ? 'Vanilla' : sub.loader}`;
    const badge = document.createElement('div'); badge.className = `sync-status ${sub.status}`;
    badge.textContent = !sub.enabled ? '자동 동기화 일시 중지' : SYNC_LABELS[sub.status] || '대기';
    const message = document.createElement('p'); message.className = 'subtle'; message.textContent = sub.message;
    const folder = document.createElement('div'); folder.className = 'sync-path'; folder.textContent = sub.modsDir;
    const actions = document.createElement('div'); actions.className = 'mc-row';
    const addButton = (label, fn) => {
      const button = document.createElement('button'); button.className = 'mc-btn xs'; button.textContent = label;
      button.disabled = sub.status === 'syncing';
      button.onclick = async () => {
        button.disabled = true;
        try { renderSubscriptions(await fn()); } catch (e) { showToast(e.message, true); } finally { button.disabled = false; }
      };
      actions.append(button);
    };
    addButton('지금 동기화', () => window.devkit.syncNow(sub.key));
    addButton(sub.enabled ? '자동 동기화 중지' : '자동 동기화 켜기', () => window.devkit.syncToggle(sub.key, !sub.enabled));
    addButton('참가 해제', async () => {
      if (!confirm('자동 동기화 연결을 해제할까요? 설치된 모드와 백업 파일은 게임 폴더에 남습니다.')) return rows;
      return window.devkit.syncLeave(sub.key);
    });
    card.append(heading, environment, badge, message, folder, actions);
    if (sub.backupDir) {
      const backup = document.createElement('div'); backup.className = 'sync-path'; backup.textContent = `최근 백업: ${sub.backupDir}`; card.append(backup);
    }
    grid.append(card);
  }
}

function updateVersionHint() {
  const version = document.getElementById('cfgVersion').value;
  const [major, minor, patch = 0] = version.split('.').map(Number);
  const java = major >= 26 ? 25 : minor >= 21 || minor === 20 && patch >= 5 ? 21 : minor >= 18 ? 17 : minor >= 17 ? 16 : 8;
  document.getElementById('versionHint').textContent = `Minecraft ${version} · Java ${java} 이상 자동 준비. 버전 변경 시 제작 모드도 해당 버전용으로 빌드해야 합니다.`;
  document.getElementById('workspaceEnvironment').textContent = `${document.getElementById('cfgServerType').selectedOptions[0].textContent} · Minecraft ${version} · Java ${java}+`;
}
document.getElementById('cfgVersion').addEventListener('change', updateVersionHint);
document.querySelectorAll('.prop-row').forEach(row => {
  const control = row.querySelector('input,select');
  const label = row.querySelector('.prop-label');
  if (control && label) control.setAttribute('aria-label', label.firstChild.textContent.trim());
});

async function updateServerRuntime() {
  if (!confirm('저장된 설정의 서버 실행 파일을 갱신할까요? 서버를 먼저 중지하세요. 기존 실행 파일은 백업됩니다.')) return;
  try {
    const response = await fetch('/api/server/update', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    showToast('서버 실행 파일 업데이트 완료. 서버를 시작할 수 있습니다.');
  } catch (e) { showToast(e.message, true); }
}

if (isElectron) {
  window.devkit.syncList().then(renderSubscriptions).catch(e => showToast(e.message, true));
  window.devkit.onSyncChanged(renderSubscriptions);
}
const invitation = new URL(location.href);
if (invitation.searchParams.has('join')) {
  const card = document.createElement('div'); card.className = 'notice';
  const text = document.createElement('p'); text.textContent = '모드팩 초대입니다. 이 페이지의 전체 링크를 복사해 자신의 MC DevKit 앱 → 서버 참가에 붙여넣으세요.';
  const button = document.createElement('button'); button.className = 'mc-btn xs'; button.textContent = '이 참가 링크 복사';
  button.onclick = () => navigator.clipboard.writeText(location.href).then(() => showToast('참가 링크를 복사했습니다.')).catch(() => showToast('주소 표시줄에서 전체 링크를 복사하세요.', true));
  card.append(text, button);
  document.getElementById('profileHomeView').prepend(card);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeJoinModal(); });
window.addEventListener('unhandledrejection', event => showToast(event.reason?.message || '작업에 실패했습니다. 연결과 설정을 확인하세요.', true));
