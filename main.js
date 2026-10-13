'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const { startServer, getState, getOwnerToken }  = require('./server');
const { ModSync } = require('./core/mod-sync');

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
  handle('sync-join', async (_, invite, launcher) => {
    const defaults = {
      official: path.join(app.getPath('appData'), '.minecraft'),
      curseforge: path.join(os.homedir(), 'curseforge', 'minecraft', 'Instances'),
      modrinth: path.join(app.getPath('appData'), 'com.modrinth.theseus', 'profiles'),
    };
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'],
      title: '이 서버 전용 게임 폴더 선택 (mods 폴더의 상위 폴더)', defaultPath: defaults[launcher] });
    if (result.canceled) return null;
    return syncManager.join(invite, result.filePaths[0], launcher);
  });
  handle('sync-now', (_, key) => syncManager.sync(key));
  handle('sync-toggle', (_, key, enabled) => syncManager.update(key, enabled));
  handle('sync-leave', (_, key) => syncManager.leave(key));

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
      await autoUpdater.checkForUpdates();
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
    autoUpdater.on('update-available', () => {
      manualCheckPending = false;
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'MC DevKit 업데이트',
        message: '새 버전이 있습니다. 백그라운드에서 다운로드합니다.',
        buttons: ['확인'],
      });
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

    autoUpdater.on('update-downloaded', () => {
      dialog.showMessageBox(win, {
        type: 'question',
        title: '업데이트 준비 완료',
        message: '새 버전 다운로드 완료. 지금 재시작하여 업데이트하시겠습니까?',
        buttons: ['재시작', '나중에'],
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
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
  Promise.resolve(syncManager?.close()).finally(() => {
    Promise.resolve(server?.shutdown()).finally(() => {
      quitReady = true;
      app.quit();
    });
  });
});
