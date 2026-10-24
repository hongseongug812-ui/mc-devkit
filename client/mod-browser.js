'use strict';

(() => {
  const root = document.getElementById('modBrowser');
  if (!root) return;
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (label, action) => {
    const element = make('button', 'mc-btn xs', label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  let context = '', pack = null, hostName = '', searchRequest = 0, installedRequest = 0, mutationRequest = 0, lastInstalledLoad = 0, mutating = false;
  let query = '', hits = [], total = 0, installedData = { installed: [], autoUpdate: true };
  let searching = false;
  const projects = new Map();
  const environment = make('p', 'field-hint');
  const heading = make('div', 'mod-browser-heading');
  heading.append(make('h3', '', '모드 검색 · 설치'), make('span', 'mod-provider', 'Modrinth'));
  const reviewButton = button('설치 변경분 검토 ↓', () => document.getElementById('packPending').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  reviewButton.hidden = true;
  heading.append(reviewButton);
  root.className = 'mod-browser';
  root.append(heading, make('p', 'subtle', '서버 버전에 맞는 모드를 찾고 필수 의존 모드까지 함께 설치하세요.'), environment);
  const form = make('form', 'mod-search');
  const input = make('input', 'mc-inp');
  input.id = 'modBrowserQuery'; input.type = 'search'; input.placeholder = '모드 이름 검색 · 예: Fabric API, Sodium';
  input.setAttribute('aria-label', 'Modrinth 모드 검색'); input.maxLength = 120;
  const searchButton = button('검색', () => search(false));
  form.append(input, searchButton);
  form.addEventListener('submit', event => { event.preventDefault(); search(false); });
  const searchStatus = make('div', 'status-note'); searchStatus.setAttribute('role', 'status');
  const results = make('div', 'mod-results');
  const more = button('더 보기', () => search(true)); more.hidden = true;
  const notice = make('div', 'status-note'); notice.setAttribute('role', 'status');
  const settings = make('div', 'mod-update-settings');
  const autoLabel = make('label', 'check-row');
  const autoInput = make('input'); autoInput.type = 'checkbox'; autoInput.checked = true;
  autoLabel.append(autoInput, document.createTextNode('설치한 모드의 새 안정 버전 자동 확인 · 30분마다'));
  const updateButton = button('모드 업데이트 확인 · 적용', () => mutate('update', {}));
  autoInput.addEventListener('change', () => {
    const wanted = autoInput.checked;
    mutate('settings', { autoUpdate: wanted }).catch(() => {});
  });
  settings.append(autoLabel, updateButton, make('p', 'field-hint', '같은 Minecraft·로더의 새 안정 버전을 설치합니다. 참가자 배포는 기존 승인 정책을 따르며, 촬영 모드와 서버 실행 중 서버 파일 변경은 보류됩니다.'));
  const installed = make('div', 'mod-installed');
  const installedStatus = make('p', 'field-hint');
  root.append(form, searchStatus, results, more, notice, settings, installedStatus, installed);

  function current(key) { return key === context && selectedPack?.id === pack?.id; }
  function message(error) { return error?.message || '모드 요청을 처리하지 못했습니다.'; }
  async function request(path, body, targetPack = pack, targetName = hostName) {
    const url = new URL(`/api/modpack/catalog/${path}`, location.origin);
    if (!body) { url.searchParams.set('id', targetPack.id); url.searchParams.set('name', targetName || ''); }
    const response = await fetch(url.pathname + url.search, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: targetPack.id, name: targetName, ...body }),
    } : undefined);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '모드 요청에 실패했습니다.');
    return data;
  }
  function updateControls() {
    const frozen = pack?.mode === 'filming';
    reviewButton.hidden = !pack?.pending;
    searchButton.disabled = searching;
    more.disabled = searching;
    autoInput.disabled = mutating;
    updateButton.disabled = mutating || frozen || !installedData.installed?.length;
    updateButton.title = frozen ? '촬영 모드를 해제한 뒤 업데이트하세요.' : '';
    for (const element of root.querySelectorAll('[data-mod-mutation]')) element.disabled = mutating || frozen || element.dataset.modUnavailable === 'true';
  }
  function renderInstalled() {
    installed.replaceChildren();
    installed.append(make('h4', '', `이 서버에서 관리하는 모드 · ${installedData.installed?.length || 0}개`));
    autoInput.checked = installedData.autoUpdate !== false;
    const lastChecked = installedData.lastChecked ? new Date(installedData.lastChecked).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : null;
    installedStatus.textContent = installedData.error || (lastChecked ? `최근 업데이트 확인: ${lastChecked}` : '새 안정 버전이 있는지 자동으로 확인합니다.');
    installedStatus.classList.toggle('inspection-error', !!installedData.error);
    for (const mod of installedData.installed || []) {
      const row = make('div', 'mod-installed-row');
      row.append(make('span', 'mod-installed-name', mod.title), make('span', 'subtle', `${mod.versionNumber} · ${(mod.sides || []).map(side => side === 'client' ? '참가자' : '서버').join(' + ')}${mod.autoUpdate === false ? ' · 자동 확인 제외' : ''}`));
      installed.append(row);
    }
    if (!installedData.installed?.length) installed.append(make('p', 'field-hint', '검색 결과에서 모드를 설치하면 버전과 업데이트 상태가 여기에 표시됩니다.'));
    updateControls();
  }
  async function loadInstalled() {
    const key = context, token = ++installedRequest, target = pack;
    lastInstalledLoad = Date.now();
    try {
      const data = await request('installed', null, target);
      if (!current(key) || token !== installedRequest) return;
      installedData = data;
      renderInstalled();
    } catch (error) { if (current(key) && token === installedRequest) installedStatus.textContent = message(error); }
  }

  function targetOptions(hit) {
    return [
      ['both', '서버 + 참가자', hit.serverSide !== 'unsupported' && hit.clientSide !== 'unsupported'],
      ['client', '참가자만', hit.clientSide !== 'unsupported'],
      ['server', '서버만', hit.serverSide !== 'unsupported'],
    ].filter(item => item[2]);
  }
  function renderResults() {
    results.replaceChildren();
    for (const hit of hits) {
      const card = make('article', 'mod-result');
      const top = make('div', 'mod-result-heading');
      top.append(make('h4', '', hit.title));
      const downloads = Number(hit.downloads);
      if (Number.isFinite(downloads)) top.append(make('span', 'field-hint', `다운로드 ${downloads.toLocaleString('ko-KR')}`));
      card.append(top, make('p', 'mod-description', hit.description));
      const state = projects.get(hit.projectId);
      const project = state?.project || hit;
      const sides = targetOptions(project);
      const sideText = project.serverSide === 'unsupported' ? '참가자 전용' : project.clientSide === 'unsupported' ? '서버 전용' : '서버 · 참가자 지원';
      card.append(make('p', 'field-hint', sideText));
      const choose = button(state?.loading ? '버전 확인 중…' : state?.versions ? '버전 다시 확인' : '버전 선택', () => loadVersions(hit));
      choose.disabled = !!state?.loading;
      card.append(choose);
      if (state?.error) card.append(make('p', 'inspection-error', state.error));
      if (state?.versions?.length) {
        const controls = make('div', 'mod-install-controls');
        const versions = make('select', 'mc-inp'); versions.setAttribute('aria-label', `${hit.title} 설치 버전`);
        for (const version of state.versions) {
          const option = make('option', '', `${version.versionNumber || version.name} · ${version.type === 'release' ? '안정' : version.type || '버전'}`);
          option.value = version.id; versions.append(option);
        }
        versions.value = state.versionId;
        versions.addEventListener('change', () => { state.versionId = versions.value; });
        const target = make('select', 'mc-inp'); target.setAttribute('aria-label', `${hit.title} 설치 대상`);
        for (const [value, label] of sides) { const option = make('option', '', label); option.value = value; target.append(option); }
        target.value = state.target;
        target.addEventListener('change', () => { state.target = target.value; });
        const auto = make('label', 'check-row'); const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.checked = state.autoUpdate;
        checkbox.addEventListener('change', () => { state.autoUpdate = checkbox.checked; });
        auto.append(checkbox, document.createTextNode('이 모드 새 안정 버전 자동 확인'));
        const install = button('선택 버전 설치 · 의존 모드 포함', () => mutate('install', { versionId: state.versionId, target: state.target, autoUpdate: state.autoUpdate }));
        install.classList.add('t-green'); install.dataset.modMutation = 'true'; install.dataset.modUnavailable = String(!sides.length);
        controls.append(versions, target, auto, install); card.append(controls);
      }
      results.append(card);
    }
    more.hidden = !hits.length || hits.length >= total;
    updateControls();
  }

  async function search(append) {
    if (!pack || myRole !== 'OWNER') return;
    const key = context, token = ++searchRequest, target = pack;
    if (!append) query = input.value.trim();
    const offset = append ? hits.length : 0;
    searching = true; searchStatus.textContent = '현재 서버 환경에 맞는 Modrinth 모드를 찾고 있습니다…'; updateControls();
    try {
      const url = new URL('/api/modpack/catalog/search', location.origin);
      url.search = new URLSearchParams({ id: target.id, name: hostName || '', q: query, offset: String(offset) }).toString();
      const response = await fetch(url.pathname + url.search);
      const data = await response.json();
      if (!current(key) || token !== searchRequest) return;
      if (!response.ok) throw Error(data.error || '모드 검색에 실패했습니다.');
      hits = append ? [...hits, ...(data.hits || [])] : data.hits || [];
      total = data.total || hits.length;
      searchStatus.textContent = hits.length ? `${total.toLocaleString('ko-KR')}개 검색 결과 · ${hits.length}개 표시` : '이 Minecraft·로더에 맞는 검색 결과가 없습니다. 다른 검색어를 입력하세요.';
      renderResults();
    } catch (error) {
      if (!current(key) || token !== searchRequest) return;
      searchStatus.textContent = message(error);
      if (!append) { hits = []; total = 0; renderResults(); }
    } finally { if (current(key) && token === searchRequest) { searching = false; updateControls(); } }
  }

  async function loadVersions(hit) {
    const key = context;
    const previous = projects.get(hit.projectId);
    if (previous?.loading) return;
    const state = { ...previous, loading: true, error: '' };
    projects.set(hit.projectId, state); renderResults();
    try {
      const url = new URL('/api/modpack/catalog/versions', location.origin);
      url.search = new URLSearchParams({ id: pack.id, name: hostName || '', project: hit.projectId }).toString();
      const response = await fetch(url.pathname + url.search);
      const data = await response.json();
      if (!current(key) || projects.get(hit.projectId) !== state) return;
      if (!response.ok) throw Error(data.error || '모드 버전을 불러오지 못했습니다.');
      state.project = data.project || hit;
      state.versions = data.versions || [];
      state.versionId = state.versions.find(version => version.type === 'release')?.id || state.versions[0]?.id || '';
      state.target = targetOptions(state.project)[0]?.[0] || 'both';
      state.autoUpdate = true;
      if (!state.versions.length) state.error = '현재 Minecraft·로더에 맞는 설치 버전이 없습니다.';
    } catch (error) { if (current(key) && projects.get(hit.projectId) === state) state.error = message(error); }
    finally { if (current(key) && projects.get(hit.projectId) === state) { state.loading = false; renderResults(); } }
  }

  async function mutate(action, body) {
    if (!pack || mutating) return;
    const key = context, token = ++mutationRequest, target = pack, targetName = hostName;
    mutating = true; notice.classList.remove('inspection-error');
    notice.textContent = action === 'install' ? '선택한 모드와 필수 의존 모드를 검증하고 설치하고 있습니다…' : action === 'update' ? '새 안정 버전과 의존 모드를 확인하고 있습니다…' : '자동 업데이트 설정을 저장하고 있습니다…';
    updateControls();
    try {
      const data = await request(action, body, target, targetName);
      if (!current(key) || token !== mutationRequest) return;
      if (data.pack && selectedPack?.id === target.id) {
        selectedPack = { ...selectedPack, ...data.pack };
        pack = selectedPack;
        renderPublishedPack(data.pack.manifest); renderStudioPack(selectedPack);
      }
      notice.textContent = data.message || (action === 'settings' ? '자동 업데이트 설정을 저장했습니다.' : '모드 확인을 마쳤습니다. 변경분을 확인하고 참가자 배포를 승인하세요.');
      if (action === 'settings') { installedData = data; renderInstalled(); }
      else await loadInstalled();
    } catch (error) {
      if (!current(key) || token !== mutationRequest) return;
      notice.textContent = message(error); notice.classList.add('inspection-error'); renderInstalled();
    } finally { if (current(key) && token === mutationRequest) { mutating = false; updateControls(); } }
  }

  window.refreshModBrowser = data => {
    root.hidden = myRole !== 'OWNER';
    if (root.hidden || !data?.id) return;
    const key = `${data.id}|${data.minecraft}|${data.loader}`;
    pack = data; hostName = currentProfileName;
    environment.textContent = `Minecraft ${data.minecraft} · ${data.loader === 'none' ? 'Vanilla' : data.loader} · 저장된 서버 배포 환경 기준`;
    if (key === context) { updateControls(); if (!mutating && Date.now() - lastInstalledLoad >= 15000) loadInstalled(); return; }
    context = key; mutationRequest++; projects.clear(); hits = []; total = 0; mutating = false; searching = false;
    installedData = { installed: [], autoUpdate: true };
    input.value = ''; notice.textContent = ''; results.replaceChildren(); more.hidden = true;
    renderInstalled(); loadInstalled(); search(false);
  };
  root.hidden = true;
  if (selectedPack) window.refreshModBrowser(selectedPack);
})();
