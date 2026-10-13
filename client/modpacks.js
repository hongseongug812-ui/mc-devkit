'use strict';

let selectedPack = null;
const el=id=>document.getElementById(id);
function textRow(parent,text,className='subtle') {const row=document.createElement('div');row.className=className;row.textContent=text;parent.append(row);return row;}
function renderStudioPack(data) {
  const pending=data.pending, preview=el('packPending');preview.replaceChildren();
  if(!pending)textRow(preview,'준비된 변경분이 없습니다. 원본을 선택하고 검사를 시작하세요.');
  else {
    textRow(preview,`준비 ${pending.manifest.revision.slice(0,8)} · 추가 ${pending.diff.added.length} · 교체 ${pending.diff.changed.length} · 제거 ${pending.diff.removed.length}`,'release-summary');
    for(const [key,label] of [['added','추가'],['changed','교체'],['removed','제거']])for(const name of pending.diff[key])textRow(preview,`${label} · ${name}`,'pack-file-row');
    for(const msg of pending.validation.errors)textRow(preview,msg,'inspection-error');
    for(const msg of pending.validation.warnings)textRow(preview,msg,'inspection-warning');
    if(!pending.validation.errors.length)textRow(preview,`모드 메타데이터 검사 통과 · ${pending.validation.mods.length}개 모드. 실제 게임 실행으로 촬영 전 최종 확인하세요.`,'inspection-ok');
  }
  const frozen=data.mode==='filming';
  el('approvePackBtn').disabled=!pending || !!pending.validation.errors.length || frozen || pending.manifest.revision===data.manifest?.revision;
  el('filmingPackBtn').disabled=!data.manifest;
  el('filmingPackBtn').textContent=frozen?'촬영 종료 · 배포 고정 해제':'촬영 모드 켜기';
  if(frozen)el('packStatus').textContent=`촬영 모드 · ${data.pinnedRevision.slice(0,8)} 고정. 변경분은 승인 전까지 적용되지 않습니다.`;
  const history=el('packHistory'), value=history.value;history.replaceChildren();
  for(const h of data.history || []) {const option=document.createElement('option');option.value=h.revision;option.textContent=`${h.revision.slice(0,8)} · ${new Date(h.publishedAt).toLocaleString()} · ${h.files}개`;history.append(option);}
  if([...history.options].some(o=>o.value===value))history.value=value;
  const participants=el('packParticipants');participants.replaceChildren();
  const list=data.participants||[];el('packReadySummary').textContent=`준비 완료 ${list.filter(p=>p.ready).length} / 연결 ${list.filter(p=>p.online).length}명 · 15초마다 확인`;
  for(const p of list) {const row=document.createElement('div');row.className='participant-row';textRow(row,p.name,'participant-name');textRow(row,!p.online?'연결 끊김':p.ready?'준비 완료':SYNC_LABELS[p.status]||'확인 필요',p.ready?'inspection-ok':'subtle');participants.append(row);}
  if(!list.length)textRow(participants,'참가자가 연결되면 준비 상태가 표시됩니다.');
  if(data.inviteEnabled===false)el('packInviteStatus').textContent='초대 사용 중지됨 · 기존 연결 만료';
}
async function studioAction(action,body) {
  if(!selectedPack)throw Error('서버를 먼저 선택하세요.');
  const response=await fetch(`/api/modpack/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentProfileName,id:selectedPack.id,...body})});
  const data=await response.json();if(!response.ok)throw Error(data.error);
  selectedPack={...selectedPack,...data};renderPublishedPack(data.manifest);renderStudioPack(selectedPack);el('packMode').value=data.mode;return data;
}
async function approvePack() {try{await studioAction('promote',{revision:selectedPack?.pending?.manifest.revision,allowEmpty:el('packEmpty').checked});el('packEmpty').checked=false;showToast('승인 배포 완료. 참가자의 게임 시작 시 자동 적용됩니다.');}catch(e){showToast(e.message,true);}}
async function toggleFilming() {try{await studioAction('mode',{mode:selectedPack.mode==='filming'?'review':'filming'});showToast(selectedPack.mode==='filming'?'현재 배포를 고정했습니다.':'촬영 모드를 해제했습니다. 변경분을 확인하고 승인하세요.');}catch(e){showToast(e.message,true);}}
async function restorePack() {
  if(!el('packHistory').value || !confirm('선택한 이전 배포를 복원할까요? 참가자의 다음 게임 시작에 복원 배포가 적용됩니다. 자동 배포는 승인 모드로 전환됩니다.'))return;
  try{await studioAction('restore',{revision:el('packHistory').value});showToast('이전 배포 복원 완료.');}catch(e){showToast(e.message,true);}
}
async function manageInvite(action) {
  if(!confirm(action==='rotate'?'기존 참가자 연결이 만료됩니다. 초대를 재발급할까요?':'기존 참가자 연결이 만료됩니다. 초대를 중지할까요?'))return;
  try{await studioAction('invite',{action});el('packInviteStatus').textContent=action==='rotate'?'재발급 완료. 새 참가 링크를 복사해 전달하세요.':'초대 사용 중지됨';}catch(e){showToast(e.message,true);}
}
async function saveTunnelSettings() {
  try{const response=await fetch('/api/tunnel/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:el('tunnelMode').value,origin:el('tunnelOrigin').value.trim(),token:el('tunnelToken').value.trim()})});const data=await response.json();if(!response.ok)throw Error(data.error);el('tunnelToken').value='';if(data.origin)el('packBase').value=data.origin;showToast('공유 설정 저장 완료. 상단에서 터널을 켜세요.');}catch(e){showToast(e.message,true);}
}
async function refreshLauncherProfiles() {
  if(!isElectron)return;
  try{const profiles=await window.devkit.launcherProfiles(),select=el('joinProfile');select.replaceChildren();const manual=document.createElement('option');manual.value='';manual.textContent='게임 폴더 직접 선택';select.append(manual);
    for(const p of profiles.filter(p=>p.launcher===el('joinLauncher').value)) {const option=document.createElement('option');option.value=p.key;option.textContent=`${p.name} · ${p.minecraft||'버전 확인 필요'} · ${p.loader||'로더 확인 필요'} ${p.loaderVersion||''}`;select.append(option);}
  }catch(e){el('joinStatus').textContent=e.message;}
}
let loaderRequest=0;
async function loadLoaderVersions(wanted='') {
  const type=el('cfgServerType').value,mc=el('cfgVersion').value,request=++loaderRequest,select=el('cfgLoaderVersion');
  select.replaceChildren();const auto=document.createElement('option');auto.value='';auto.textContent='자동 · 권장 안정 버전';select.append(auto);
  if(!['fabric','forge','neoforge','cardboard'].includes(type))return;
  try{const response=await fetch(`/api/loaders/${type}/${encodeURIComponent(mc)}`);const rows=await response.json();if(request!==loaderRequest)return;if(!response.ok)throw Error(rows.error);
    for(const item of rows){const option=document.createElement('option');option.value=item.version;option.textContent=item.version;select.append(option);}
    if(wanted && ![...select.options].some(o=>o.value===wanted)){const option=document.createElement('option');option.value=wanted;option.textContent=`${wanted} · 저장된 버전`;select.append(option);}
    select.value=wanted;
  }catch(e){if(request===loaderRequest){if(wanted){const option=document.createElement('option');option.value=wanted;option.textContent=wanted;select.append(option);select.value=wanted;}showToast(`로더 목록 조회 실패: ${e.message}`,true);}}
}
let packRefreshBusy=false;
async function refreshPackState(){
  if(packRefreshBusy || myRole!=='OWNER' || el('tab-pack').style.display==='none' || !selectedPack || document.hidden)return;
  packRefreshBusy=true;
  try{const response=await fetch(`/api/modpack?name=${encodeURIComponent(currentProfileName||'')}`);if(!response.ok)return;const data=await response.json();if(data.id!==selectedPack?.id)return;selectedPack={...selectedPack,...data};renderPublishedPack(data.manifest);renderStudioPack(selectedPack);}catch{}finally{packRefreshBusy=false;}
}
setInterval(refreshPackState,15000);
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
    document.getElementById('packMode').value = data.mode || 'review';
    document.getElementById('packConfigSource').value = data.configSourceDir || '';
    document.getElementById('packConfigPatterns').value = (data.configPatterns || []).join(', ');
    document.getElementById('packLoaderVersion').value = data.loaderVersion || '';
    document.getElementById('packLoaderVersion').disabled = !!data.manifest;
    document.getElementById('packVersion').textContent = `${data.name} · Minecraft ${data.minecraft}`;
    if (!document.getElementById('packBase').value || tunnelUrl) document.getElementById('packBase').value = tunnelUrl || '';
    renderPublishedPack(data.manifest);
    renderStudioPack(data);
    const settings=await fetch('/api/tunnel/settings').then(r=>r.json());
    document.getElementById('tunnelMode').value=settings.mode || 'quick';
    document.getElementById('tunnelOrigin').value=settings.origin || '';
    if(settings.origin)document.getElementById('packBase').value=settings.origin;
  } catch (e) { status.textContent = e.message; }
}

function renderPublishedPack(manifest) {
  document.getElementById('packStatus').textContent = manifest
    ? `배포 ${manifest.revision.slice(0, 8)} · ${manifest.files.length}개 · ${new Date(manifest.publishedAt).toLocaleString()}`
    : '승인된 배포가 없습니다. 모드를 준비하고 검사를 마친 뒤 승인하세요.';
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
        loader: document.getElementById('packLoader').value, autoPublish: document.getElementById('packAuto').checked,
        loaderVersion:document.getElementById('packLoaderVersion').value.trim(),mode:document.getElementById('packMode').value,
        configSourceDir:document.getElementById('packConfigSource').value,
        configPatterns:document.getElementById('packConfigPatterns').value.split(',').map(p=>p.trim()).filter(Boolean) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    selectedPack = { ...selectedPack, ...data };
    renderPublishedPack(data.manifest);
    renderStudioPack(selectedPack);
    document.getElementById('packLoader').disabled = !!data.manifest;
    showToast(data.pending?.validation.errors.length?'검사 오류가 있습니다. 변경 목록을 확인하세요.':'변경분 준비 완료. 정책과 변경 목록을 확인하세요.',!!data.pending?.validation.errors.length);
  } catch (e) {
    document.getElementById('packStatus').textContent = e.message;
    showToast(e.message, true);
  } finally { button.disabled = false; }
}

async function copyPackInvite() {
  try {
    if (!selectedPack?.manifest) throw new Error('모드팩을 먼저 배포하세요.');
    if (selectedPack.inviteEnabled === false) throw Error('초대 사용이 중지됐습니다. 초대를 재발급하세요.');
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
  refreshLauncherProfiles();
}
function closeJoinModal() { document.getElementById('joinModal').style.display = 'none'; }

async function joinPack() {
  const button = document.getElementById('joinBtn');
  button.disabled = true;
  document.getElementById('joinStatus').textContent = '이 서버용 게임 폴더를 선택하세요.';
  try {
    const rows = await window.devkit.syncJoin(document.getElementById('joinInvite').value.trim(), document.getElementById('joinLauncher').value,{
      profileKey:document.getElementById('joinProfile').value,nickname:document.getElementById('joinNickname').value,
      syncConfig:document.getElementById('joinConfig').checked,acknowledged:document.getElementById('joinAcknowledged').checked});
    if (!rows) { document.getElementById('joinStatus').textContent = '폴더 선택을 취소했습니다.'; return; }
    renderSubscriptions(rows);
    closeJoinModal();
    showToast('연결 완료. 참가 서버의 게임 시작을 누르면 모드와 설정이 자동 적용됩니다.');
  } catch (e) {
    document.getElementById('joinStatus').textContent = e.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  } finally { button.disabled = false; }
}

const SYNC_LABELS = { current: '시작 준비 완료', updated: '업데이트 적용', waiting: '게임 종료 대기', error: '확인 필요', pending: '시작 시 자동 적용', syncing: '적용 중', 'config-pending':'공용 설정 적용 필요',paused:'연결 일시 중지' };
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
    addButton('▶ 게임 시작 · 자동 적용', async()=>{
      const result=await window.devkit.syncStart(sub.key);showToast(result.message);return result.subscriptions;
    });
    actions.lastChild.classList.add('game-start');
    addButton('미리 적용', () => window.devkit.syncNow(sub.key));
    addButton('런처 · 바로가기 연결',()=>window.devkit.syncLauncher(sub.key));
    addButton(sub.enabled ? '업데이트 확인 중지' : '업데이트 확인 켜기', () => window.devkit.syncToggle(sub.key, !sub.enabled));
    const configLabel=document.createElement('label');configLabel.className='check-row';
    const configInput=document.createElement('input');configInput.type='checkbox';configInput.checked=!!sub.syncConfig;
    configInput.onchange=async()=>{try{renderSubscriptions(await window.devkit.syncToggle(sub.key,{syncConfig:configInput.checked}));}catch(e){showToast(e.message,true);}};
    configLabel.append(configInput,document.createTextNode('게임 시작 시 공용 설정 적용'));card.append(configLabel);
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
document.getElementById('cfgVersion').addEventListener('change',()=>loadLoaderVersions());
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
