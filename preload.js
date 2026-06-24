'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// renderer 에서 window.devkit.xxx() 로 안전하게 호출
contextBridge.exposeInMainWorld('devkit', {
  // 프로젝트 폴더 선택 다이얼로그 열기
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // 현재 앱 상태 (serverStatus, tunnelUrl 등)
  getState: () => ipcRenderer.invoke('get-state'),

  // 외부 브라우저로 URL 열기
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Electron 여부 확인 (UI에서 분기 처리용)
  isElectron: true,
});
