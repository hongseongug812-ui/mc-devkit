'use strict';
// Isolated renderer smoke test; never opens a game server or modifies real profiles.
const path = require('path');
const fs = require('fs-extra');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = path.resolve(__dirname,'../.test-data/ui');
process.env.DEVKIT_DATA_DIR = root;
fs.ensureDirSync(path.join(root, 'electron'));
app.setPath('userData', path.join(root, 'electron'));
app.setPath('sessionData', path.join(root, 'electron'));
app.commandLine.appendSwitch('disable-gpu');
console.log('Starting isolated renderer smoke test');
let server;
function installCatalogMock() {
  const originalFetch = window.fetch.bind(window);
  const state = window.__catalogSmoke = { requests: [], installed: [], autoUpdate: true, installs: [], updates: 0 };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.origin);
    if (!url.pathname.startsWith('/api/modpack/catalog/')) return originalFetch(input, init);
    const action = url.pathname.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : null;
    state.requests.push({ action, body, query: url.searchParams.get('q') });
    let data, status = 200;
    const installed = () => ({ installed: state.installed, autoUpdate: state.autoUpdate, lastChecked: new Date().toISOString() });
    if (action === 'search') {
      if (url.searchParams.get('q') === 'empty') data = { hits: [], total: 0 };
      else if (url.searchParams.get('q') === 'error') { data = { error: 'Smoke catalog unavailable' }; status = 503; }
      else data = { hits: [{ projectId: 'smoke-project', slug: 'smoke-project', title: 'Smoke Mod <test>', description: 'Compatible installed-profile smoke fixture', downloads: 12345, serverSide: 'required', clientSide: 'required' }], total: 1 };
    } else if (action === 'versions') data = { versions: [{ id: 'smoke-v2', name: 'Smoke 2', versionNumber: '2.0.0', type: 'release' }, { id: 'smoke-beta', name: 'Smoke beta', versionNumber: '3.0-beta', type: 'beta' }] };
    else if (action === 'installed') data = installed();
    else if (action === 'install') {
      state.installs.push(body);
      state.installed = [{ title: 'Smoke Mod', versionNumber: '2.0.0', sides: ['server', 'client'], autoUpdate: body.autoUpdate }, { title: 'Required Dependency', versionNumber: '1.0.0', sides: ['server', 'client'] }];
      data = { message: 'Smoke install reviewed; dependencies included' };
    } else if (action === 'settings') { state.autoUpdate = body.autoUpdate; data = installed(); }
    else if (action === 'update') { state.updates += 1; data = { message: 'Smoke update checked' }; }
    else { data = { error: 'Unexpected catalog mock route' }; status = 500; }
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
app.whenReady().then(async () => {
  await fs.ensureDir(root);
  await fs.emptyDir(path.join(root,'packs'));
  await fs.writeJson(path.join(root,'config.json'),{serverDir:path.join(root,'servers'),serverFolder:'shoot',serverType:'fabric',paperVersion:'26.3',memory:'4G',projectDir:path.join(root,'project')});
  await fs.writeJson(path.join(root,'profiles.json'),{
    '콘텐츠 촬영 서버':{serverDir:path.join(root,'servers'),serverFolder:'shoot',serverType:'fabric',paperVersion:'26.3',memory:'4G'},
    '미니게임 스튜디오':{serverDir:path.join(root,'servers'),serverFolder:'mini',serverType:'paper',paperVersion:'1.21.11',memory:'6G'},
    '테스트 월드':{serverDir:path.join(root,'servers'),serverFolder:'test',serverType:'vanilla',paperVersion:'26.3',memory:'2G'},
  });
  const service=require(process.env.DEVKIT_TEST_ASAR ? path.join(process.env.DEVKIT_TEST_ASAR,'server.js') : '../server');
  server=await service.startServer(0);
  const errors=[];
  let smokeWindow;
  let account = { configured: false, clientId: '', account: null, pending: null, busy: false, error: '' };
  const accountCalls = { configure: 0, login: 0, cancel: 0, logout: 0, play: 0, external: [] };
  const updateAccount = changes => {
    account = { ...account, ...changes };
    smokeWindow?.webContents.send('account-changed', account);
    return account;
  };
  ipcMain.handle('owner-token',()=>service.getOwnerToken());
  ipcMain.handle('sync-list',()=>[]);
  ipcMain.handle('account-status', () => account);
  ipcMain.handle('account-configure', (_, clientId) => { accountCalls.configure += 1; return updateAccount({ configured: true, clientId, error: '' }); });
  ipcMain.handle('account-login', () => {
    accountCalls.login += 1;
    return updateAccount({ account: null, busy: true, error: '', pending: { userCode: 'SMOKE-CODE', verificationUri: 'https://www.microsoft.com/link', expiresAt: Date.now() + 60000 } });
  });
  ipcMain.handle('account-cancel', () => { accountCalls.cancel += 1; return updateAccount({ pending: null, busy: false, error: '' }); });
  ipcMain.handle('account-logout', () => { accountCalls.logout += 1; return updateAccount({ account: null, pending: null, busy: false, error: '' }); });
  ipcMain.handle('open-external', (_, url) => { accountCalls.external.push(url); });
  ipcMain.handle('sync-play', async () => { accountCalls.play += 1; await new Promise(resolve => setTimeout(resolve, 100)); return { launched: true, message: 'Smoke game prepared', subscriptions: [] }; });
  ipcMain.handle('launcher-profiles',()=>[{key:'a'.repeat(32),name:'촬영 게임',minecraft:'26.3',loader:'fabric',loaderVersion:'0.18.4',launcher:'official'}]);
  const window=new BrowserWindow({show:false,width:1440,height:940,webPreferences:{preload:process.env.DEVKIT_TEST_ASAR ? path.join(process.env.DEVKIT_TEST_ASAR,'preload.js') : path.resolve(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false}});
  smokeWindow = window;
  window.webContents.on('console-message',(_,level,message)=>{if(level===3 && !message.includes('ERR_'))errors.push(message);});
  await window.loadURL(`http://localhost:${server.address().port}`);
  const waitFor = async expression => {
    const until=Date.now()+30000;
    while(Date.now()<until){if(await window.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,100));}
    throw Error(`Renderer condition timed out: ${expression}`);
  };
  const capture = async filename => {
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(path.join(root,filename),(await window.webContents.capturePage()).toPNG());
  };
  await waitFor('myRole === "OWNER" && document.querySelectorAll(".profile-card").length === 3');
  await waitFor('window.mcAccount && !mcAccount.getState().loading');
  if (!await window.webContents.executeJavaScript('!mcAccountSetup.hidden && mcAccountLogin.disabled')) throw Error('Unconfigured account setup state missing');
  await window.webContents.executeJavaScript('mcAccount.focus()');
  if (!await window.webContents.executeJavaScript('mcAccountSetup.open')) throw Error('Account setup did not open when focused');
  await window.webContents.executeJavaScript('mcAccountClientId.value="invalid";mcAccountSave.click()');
  if (accountCalls.configure || !await window.webContents.executeJavaScript('!mcAccountError.hidden')) throw Error('Invalid application ID was accepted');
  await window.webContents.executeJavaScript('mcAccountClientId.value="12345678-1234-1234-1234-123456789abc";mcAccountClientId.dispatchEvent(new Event("input"));mcAccountSave.click()');
  await waitFor('mcAccount.getState().configured && !mcAccountLogin.disabled');
  if (accountCalls.configure !== 1) throw Error('Account configuration did not use IPC');
  await window.webContents.executeJavaScript('mcAccountLogin.click()');
  await waitFor('!mcAccountPending.hidden && mcAccountCode.textContent === "SMOKE-CODE" && !mcAccountCancel.disabled');
  await capture('account-device-code.png');
  await window.webContents.executeJavaScript('mcAccountOpen.click();mcAccountCancel.click()');
  await waitFor('mcAccountPending.hidden && !mcAccountLogin.disabled');
  if (accountCalls.external[0] !== 'https://www.microsoft.com/link' || accountCalls.cancel !== 1) throw Error('Account device-code open/cancel flow failed');
  await window.webContents.executeJavaScript('mcAccountLogin.click()');
  await waitFor('!mcAccountPending.hidden');
  updateAccount({ busy: false, pending: { ...account.pending, expiresAt: Date.now() - 1000 } });
  await waitFor('!mcAccountLogin.disabled && mcAccountOpen.disabled && mcAccountCopy.disabled');
  await window.webContents.executeJavaScript('mcAccountLogin.click()');
  await waitFor('mcAccount.getState().pending?.expiresAt > Date.now() && !mcAccount.getState().working');
  if (accountCalls.login !== 3 || accountCalls.cancel !== 2) throw Error('Expired account code did not retry safely');
  updateAccount({ busy: false, pending: null, account: { id: 'a'.repeat(32), name: 'SmokePlayer' } });
  await waitFor('mcAccount.canPlay() && mcAccountBadge.classList.contains("linked")');
  await capture('account-linked.png');
  await window.webContents.executeJavaScript('mcAccountLogout.click()');
  await waitFor('!mcAccount.getState().account && !mcAccountLogin.disabled');
  if (accountCalls.logout !== 1) throw Error('Account logout did not use IPC');
  updateAccount({ error: 'Smoke login error' });
  await waitFor('!mcAccountError.hidden && mcAccountError.textContent === "Smoke login error"');
  updateAccount({ error: '', account: { id: 'a'.repeat(32), name: 'SmokePlayer' } });
  await waitFor('mcAccount.canPlay()');
  await window.webContents.executeJavaScript(`(${installCatalogMock.toString()})();`);
  await window.webContents.executeJavaScript('document.fonts.ready');
  await capture('home.png');
  await window.webContents.executeJavaScript('loadProfile("콘텐츠 촬영 서버")');
  await waitFor('document.getElementById("sidebarView").style.display === "flex"');
  await window.webContents.executeJavaScript('openProfileWorkspace("tab-settings")');
  await waitFor('document.getElementById("cfgVersion").value === "26.3"');
  await capture('settings.png');
  if(!await window.webContents.executeJavaScript('JSON.stringify([...document.getElementById("cfgServerType").options].map(o=>o.value).sort()) === JSON.stringify(["paper","fabric","forge","neoforge","vanilla","arclight","cardboard"].sort())'))throw Error('Existing or new server types missing');
  await window.webContents.executeJavaScript('document.getElementById("cfgMemory").value="6G";saveSettingsPanel()');
  const saved=await fs.readJson(path.join(root,'config.json'));
  if(saved.memory!=='6G')throw Error('Settings did not persist');
  await window.webContents.executeJavaScript('openProfileWorkspace("tab-pack");loadPackPanel()');
  await waitFor('document.getElementById("packSource").value.length > 0');
  await waitFor('document.querySelectorAll("#modBrowser .mod-result").length === 1');
  if (!await window.webContents.executeJavaScript('document.querySelector("#modBrowser .mod-result h4").textContent === "Smoke Mod <test>" && !document.querySelector("#modBrowser .mod-result h4 test")')) throw Error('Catalog result text was not rendered safely');
  await window.webContents.executeJavaScript('document.querySelector("#modBrowser .mod-result button").click()');
  await waitFor('document.querySelectorAll("#modBrowser .mod-install-controls select").length === 2');
  if (!await window.webContents.executeJavaScript('document.querySelector("#modBrowser .mod-install-controls select").value === "smoke-v2"')) throw Error('Stable mod release was not selected');
  await window.webContents.executeJavaScript('document.querySelector("#modBrowser [data-mod-mutation]").click()');
  await waitFor('document.querySelectorAll("#modBrowser .mod-installed-row").length === 2 && !document.querySelector("#modBrowser [data-mod-mutation]").disabled');
  if (!await window.webContents.executeJavaScript('__catalogSmoke.installs.length === 1 && __catalogSmoke.installs[0].versionId === "smoke-v2" && __catalogSmoke.installs[0].target === "both"')) throw Error('Catalog install selection did not preserve version and target');
  await window.webContents.executeJavaScript('const box=document.querySelector("#modBrowser .mod-update-settings input");box.checked=false;box.dispatchEvent(new Event("change"))');
  await waitFor('__catalogSmoke.autoUpdate === false && !document.querySelector("#modBrowser .mod-update-settings input").disabled');
  await window.webContents.executeJavaScript('document.querySelector("#modBrowser .mod-update-settings button").click()');
  await waitFor('__catalogSmoke.updates === 1 && !document.querySelector("#modBrowser .mod-update-settings button").disabled');
  await window.webContents.executeJavaScript('document.getElementById("modBrowser").scrollIntoView({block:"start"})');
  await capture('mod-browser.png');
  await window.webContents.executeJavaScript('document.getElementById("tab-pack").scrollTop=0');
  await window.webContents.executeJavaScript('modBrowserQuery.value="empty";document.querySelector("#modBrowser form").requestSubmit()');
  await waitFor('document.querySelectorAll("#modBrowser .mod-result").length === 0 && !document.querySelector("#modBrowser form button").disabled');
  await window.webContents.executeJavaScript('modBrowserQuery.value="error";document.querySelector("#modBrowser form").requestSubmit()');
  await waitFor('document.querySelector("#modBrowser .status-note").textContent === "Smoke catalog unavailable"');
  await window.webContents.executeJavaScript('modBrowserQuery.value="smoke";document.querySelector("#modBrowser form").requestSubmit()');
  await waitFor('document.querySelectorAll("#modBrowser .mod-result").length === 1');
  await capture('modpack.png');
  const {fabric}=require('../test/jar-fixture');
  const source=await window.webContents.executeJavaScript('document.getElementById("packSource").value');
  await fs.outputFile(path.join(source,'creator.jar'),fabric());
  await window.webContents.executeJavaScript('document.getElementById("packAuto").checked=false;document.getElementById("packLoaderVersion").value="0.18.4";publishPack()');
  await waitFor('selectedPack?.pending?.validation.errors.length === 0');
  if(await window.webContents.executeJavaScript('!!selectedPack.manifest'))throw Error('Review published before approval');
  await capture('review.png');
  await window.webContents.executeJavaScript('approvePack()');
  await waitFor('!!selectedPack.manifest');
  await window.webContents.executeJavaScript('toggleFilming()');
  await waitFor('selectedPack.mode === "filming"');
  if (!await window.webContents.executeJavaScript('document.querySelector("#modBrowser .mod-update-settings button").disabled')) throw Error('Filming mode did not disable catalog updates');
  await capture('filming.png');
  await window.webContents.executeJavaScript('closeProfileWorkspace();openJoinModal()');
  await capture('join.png');
  await waitFor('document.getElementById("joinProfile").options.length === 2');
  await window.webContents.executeJavaScript('renderSubscriptions([{key:"test",name:"촬영 서버",minecraft:"26.3",loader:"fabric",syncConfig:true,enabled:true,status:"pending",message:"게임 시작 시 승인 배포를 자동 적용합니다.",modsDir:"C:/Games/Creator/mods"}])');
  if(!await window.webContents.executeJavaScript('document.querySelector(".game-start").textContent.includes("게임 시작")'))throw Error('Participant play button missing');
  await window.webContents.executeJavaScript('document.querySelector(".game-start").click();document.querySelector(".game-start").click()');
  await waitFor('!gameLaunchBusy && !document.querySelector(".game-start")');
  if (accountCalls.play !== 1) throw Error('Participant linked-account play did not guard duplicate launches');
  await window.webContents.executeJavaScript('closeJoinModal();openProfileWorkspace("tab-team")');
  await capture('team.png');
  await window.webContents.executeJavaScript('openSrvPropModal()');
  await capture('properties.png');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('Renderer smoke test passed: account setup/device code/expiry/cancel/link/logout, catalog search/install/dependencies/auto-update, owner settings/review/filming, exact profiles and guarded linked-account play.');
  window.destroy();
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(server)await server.shutdown();
  app.exit(process.exitCode || 0);
});
