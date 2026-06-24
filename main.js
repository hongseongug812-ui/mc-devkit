'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { startServer, getState }  = require('./server');

const isDev = process.argv.includes('--dev');

// 패키징된 앱에서 번들 리소스 경로 노출 (server-manager가 읽음)
if (app.isPackaged) {
  process.env.DEVKIT_RESOURCES = process.resourcesPath;
}
const PORT  = 3847;

let win    = null;
let tray   = null;
let server = null;

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

  win.on('close', (e) => {
    // X 버튼 → 트레이로 최소화 (종료 아님)
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
  // 프로젝트 폴더 선택 다이얼로그
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title:      '플러그인 프로젝트 폴더 선택',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 현재 상태 조회
  ipcMain.handle('get-state', () => getState());

  // 외부 URL 열기
  ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
}

// ── 강제 종료 ───────────────────────────────────────────────────────────────
function forceQuit() {
  win.destroy();
  app.quit();
}

// ── 앱 라이프사이클 ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  server = await startServer(PORT);

  createWindow();
  createTray();
  registerIpc();

  // 자동 업데이트 (배포 빌드에서만)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'MC DevKit 업데이트',
        message: '새 버전이 있습니다. 백그라운드에서 다운로드합니다.',
        buttons: ['확인'],
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
  }
});

app.on('window-all-closed', (e) => {
  // 모든 창 닫혀도 앱은 트레이에서 살아있음
  e.preventDefault();
});

app.on('activate', () => {
  // macOS: Dock 클릭 시 창 복원
  if (win) win.show();
});

app.on('before-quit', () => {
  // 진짜 종료 시 서버 정리
  server?.close();
});
