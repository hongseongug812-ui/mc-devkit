'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const { startServer, getState, getOwnerToken, isUpdateIdle }  = require('./server');
const { ModSync } = require('./core/mod-sync');
const { discoverProfiles } = require('./core/launcher-profiles');
const { openLauncher } = require('./core/game-launcher');
const { gameRunning } = require('./core/game-process');
const { MinecraftAccount } = require('./core/minecraft-account');
const { launchMinecraft } = require('./core/minecraft-client');
const AutomaticUpdates = require('./core/automatic-updates');

const isDev = process.argv.includes('--dev');

// 단일 인스턴스 보장 — 이미 실행 중이면 기존 창만 포커스하고 종료
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// 패키징된 앱에서 번들 리소스 경로 노출 (server-manager가 읽음)
if (app.isPackaged) {
  process.env.DEVKIT_RESOURCES = process.resourcesPath;
}
const PORT  = 3847;

let win       = null;
let tray      = null;
let server    = null;
let isQuitting = false;  // 인스톨러/완전종료 시 close 막지 않음
let manualCheckPending = false;  // 수동 "업데이트 확인" 클릭 시에만 결과 팝업을 띄우기 위한 플래그
let syncManager = null;
let quitReady = false;
let shutdownPending = false;
let automaticUpdates = null;
let minecraftAccount = null;
let gameLaunchPending = false;

// ── 메인 윈도우 생성 ────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:           1280,
    height:          800,
    minWidth:        900,
    minHeight:       600,
    title:           'MC DevKit',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload:            path.join(__dirname, 'preload.js'),
      contextIsolation:   true,
      nodeIntegration:    false,
    },
  });

  // 서버가 뜰 때까지 잠깐 대기 후 로드
  setTimeout(() => {
    win.loadURL(`http://localhost:${PORT}`);
  }, 800);

  if (isDev) win.webContents.openDevTools();

  // IPC is available only to this local app, never to a remote invitation page.
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== `http://localhost:${PORT}`) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (isQuitting) return;  // 인스톨러/완전종료 시 그냥 닫힘
    e.preventDefault();
    win.hide();
    automaticUpdates?.attemptInstall().catch(()=>{});
  });
}

// ── 시스템 트레이 ───────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('MC DevKit');

  const buildMenu = () => {
    const state = getState();
    return Menu.buildFromTemplate([
      { label: `서버: ${state.serverStatus.toUpperCase()}`, enabled: false },
      { label: state.tunnelUrl || '터널 없음',            enabled: false },
      { type: 'separator' },
      { label: '대시보드 열기', click: () => { win.show(); win.focus(); } },
      { label: '브라우저로 열기', click: () => shell.openExternal(`http://localhost:${PORT}`) },
      { type: 'separator' },
      { label: '완전 종료', click: forceQuit },
    ]);
  };

  tray.setContextMenu(buildMenu());
  tray.on('double-click', () => { win.show(); win.focus(); });

  // 상태 변경 시 트레이 메뉴 갱신
  setInterval(() => tray.setContextMenu(buildMenu()), 3000);
}

// ── IPC 핸들러 (renderer → main) ───────────────────────────────────────────
function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if(shutdownPending)throw Error('앱 종료 또는 자동 업데이트를 진행하고 있습니다.');
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== `http://localhost:${PORT}`) throw new Error('로컬 앱에서만 사용할 수 있습니다.');
    return fn(event, ...args);
  });
  // 프로젝트 폴더 선택 다이얼로그
  handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title:      '플러그인 프로젝트 폴더 선택',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 현재 상태 조회
  handle('get-state', () => getState());
  handle('owner-token', () => getOwnerToken());

  // 외부 URL 열기
  handle('open-external', (_, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('웹 주소만 열 수 있습니다.');
    return shell.openExternal(url);
  });

  handle('sync-list', () => syncManager.list());
  // Account credentials stay in the main process. Only public profile/status data crosses IPC.
  handle('account-status', () => minecraftAccount.status());
  handle('account-configure', (_, clientId) => minecraftAccount.configure(clientId));
  handle('account-login', () => minecraftAccount.beginLogin());
  handle('account-cancel', () => minecraftAccount.cancelLogin());
  handle('account-logout', () => minecraftAccount.logout());
  handle('launcher-profiles', () => discoverProfiles({appData:app.getPath('appData')}));
  handle('sync-join', async (_, invite, launcher, options = {}) => {
    if(options.profileKey) {
      const profiles=await discoverProfiles({appData:app.getPath('appData')});
      const profile=profiles.find(p=>p.key===options.profileKey);
      if(!profile)throw Error('게임 프로필이 변경됐습니다. 목록을 새로고침하세요.');
      return syncManager.join(invite,profile.instanceDir,profile.launcher,{...options,environment:profile});
    }
    const defaults = {
      official: path.join(app.getPath('appData'), '.minecraft'),
      curseforge: path.join(os.homedir(), 'curseforge', 'minecraft', 'Instances'),
      modrinth: path.join(app.getPath('appData'), 'com.modrinth.theseus', 'profiles'),
    };
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'],
      title: '이 서버 전용 게임 폴더 선택 (mods 폴더의 상위 폴더)', defaultPath: defaults[launcher] });
    if (result.canceled) return null;
    return syncManager.join(invite, result.filePaths[0], launcher, {...options,environment:null});
  });
  handle('sync-now', (_, key) => syncManager.sync(key));
  handle('sync-toggle', (_, key, enabled) => syncManager.update(key, enabled));
  handle('sync-leave', (_, key) => syncManager.leave(key));
  const chooseLauncher=async()=>{
    const result=await dialog.showOpenDialog(win,{properties:['openFile'],title:'게임 런처 또는 프로필 바로가기 선택',filters:[{name:'런처 · 게임 바로가기',extensions:['exe','lnk']}]});
    return result.canceled?null:result.filePaths[0];
  };
  handle('sync-launcher', async(_,key)=>{
    const sub=syncManager.subscriptions.find(s=>s.key===key);if(!sub)throw Error('참가 서버를 찾을 수 없습니다.');
    const target=await chooseLauncher();if(target){sub.launchPath=target;await syncManager.persist();}return syncManager.list();
  });
  const startGame = async (key, launch) => {
    if (gameLaunchPending) throw Error('게임 시작을 준비 중입니다. 잠시 기다려 주세요.');
    gameLaunchPending = true;
    try { return await syncManager.startGame(key, launch); }
    finally { gameLaunchPending = false; }
  };
  handle('sync-play', (_, key) => startGame(key, async sub => {
    const session = await minecraftAccount.getSession();
    return launchMinecraft(sub, session, { appData: app.getPath('appData') });
  }));
  handle('sync-start',(_,key)=>startGame(key,sub=>openLauncher(sub,{
    openPath:target=>shell.openPath(target),select:chooseLauncher,
    save:async target=>{const saved=syncManager.subscriptions.find(s=>s.key===key);if(saved){saved.launchPath=target;await syncManager.persist();}}
  })));

  // 수동 업데이트 확인
  handle('check-for-updates', async () => {
    if (!app.isPackaged) {
      dialog.showMessageBox(win, {
        type: 'info', title: 'MC DevKit 업데이트',
        message: '개발 모드에서는 업데이트 확인을 지원하지 않습니다. 설치된 배포판에서만 동작합니다.',
        buttons: ['확인'],
      });
      return;
    }
    if (manualCheckPending) return;
    manualCheckPending = true;
    try {
      if(automaticUpdates?.ready) {
        manualCheckPending=false;
        dialog.showMessageBox(win,{type:'info',title:'자동 업데이트 준비 완료',message:'서버·게임·촬영 모드·터널을 종료하고 창을 닫아 트레이로 보내면 자동 설치 후 재실행합니다.',buttons:['확인']});
      }else await automaticUpdates.check();
    } catch (e) {
      const showError = manualCheckPending;
      manualCheckPending = false;
      if (showError) dialog.showMessageBox(win, {
        type: 'error', title: '업데이트 확인 실패', message: e.message, buttons: ['확인'],
      });
    }
  });
}

// ── 강제 종료 ───────────────────────────────────────────────────────────────
function forceQuit() {
  app.quit();
}

// ── 앱 라이프사이클 ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  server = await startServer(PORT);

  minecraftAccount = new MinecraftAccount(process.env.DEVKIT_DATA_DIR || path.join(os.homedir(), '.mc-devkit'), {
    secureStorage: safeStorage,
    onChange: status => { if (win && !win.isDestroyed()) win.webContents.send('account-changed', status); },
  });
  try { await minecraftAccount.init(); } catch {
    dialog.showErrorBox('계정 설정 확인 필요', '저장된 계정 설정을 읽을 수 없습니다. 계정 연결 화면에서 다시 연결하세요.');
  }

  createWindow();
  createTray();
  registerIpc();
  syncManager = new ModSync(process.env.DEVKIT_DATA_DIR || path.join(os.homedir(), '.mc-devkit'), {
    onChange: (subscriptions) => { if (win && !win.isDestroyed()) win.webContents.send('sync-changed', subscriptions); },
  });
  try { await syncManager.init(); } catch (e) {
    dialog.showErrorBox('모드 동기화 초기화 실패', e.message);
  }

  // 자동 업데이트 (배포 빌드에서만)
  if (app.isPackaged) {
    automaticUpdates=new AutomaticUpdates(autoUpdater,{
      isIdle:async()=>{
        if(shutdownPending || win.isVisible() || gameLaunchPending || minecraftAccount.status().busy || syncManager.locks.size || !await isUpdateIdle() || await gameRunning())return false;
        const stillIdle=await isUpdateIdle();
        return stillIdle && !shutdownPending && !win.isVisible() && !gameLaunchPending && !minecraftAccount.status().busy && !syncManager.locks.size;
      },
      beforeInstall:async()=>{
        isQuitting=true;shutdownPending=true;
        await Promise.all([minecraftAccount.close(),syncManager.close(),server.shutdown()]);quitReady=true;automaticUpdates.close();
      },
      onStatus:status=>{
        if(status==='downloading')manualCheckPending=false;
        if(win && !win.isDestroyed())win.webContents.send('update-status',status);
        if(status==='ready')tray?.setToolTip('MC DevKit · 자동 업데이트 준비 완료');
      }
    });

    // 수동으로 확인 버튼을 눌렀을 때만 "최신 버전입니다" 팝업 표시
    // (시작 시 자동 체크에서는 조용히 넘어감)
    autoUpdater.on('update-not-available', () => {
      if (!manualCheckPending) return;
      manualCheckPending = false;
      dialog.showMessageBox(win, {
        type: 'info', title: 'MC DevKit 업데이트',
        message: `이미 최신 버전입니다. (v${app.getVersion()})`,
        buttons: ['확인'],
      });
    });

    autoUpdater.on('error', (err) => {
      if (!manualCheckPending) return;
      manualCheckPending = false;
      dialog.showMessageBox(win, {
        type: 'error', title: '업데이트 확인 실패', message: err.message, buttons: ['확인'],
      });
    });

    automaticUpdates.start();
  }
});

app.on('second-instance', () => {
  // 두 번째 실행 시도 → 기존 창 포커스
  if (win) { win.show(); win.focus(); }
});

app.on('window-all-closed', (e) => {
  if (!isQuitting) e.preventDefault();  // 트레이 유지 (종료 아닐 때만)
});

app.on('activate', () => {
  if (win) win.show();
});

app.on('before-quit', (event) => {
  isQuitting = true;
  if (quitReady) return;
  event.preventDefault();
  if (shutdownPending) return;
  shutdownPending = true;
  automaticUpdates?.close();
  minecraftAccount?.close();
  Promise.resolve(syncManager?.close()).finally(() => {
    Promise.resolve(server?.shutdown()).finally(() => {
      quitReady = true;
      app.quit();
    });
  });
});
