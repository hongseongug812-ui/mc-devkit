'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// renderer 에서 window.devkit.xxx() 로 안전하게 호출
contextBridge.exposeInMainWorld('devkit', {
  // 프로젝트 폴더 선택 다이얼로그 열기
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // 현재 앱 상태 (serverStatus, tunnelUrl 등)
  getState: () => ipcRenderer.invoke('get-state'),
  ownerToken: () => ipcRenderer.invoke('owner-token'),
  syncList: () => ipcRenderer.invoke('sync-list'),
  launcherProfiles: () => ipcRenderer.invoke('launcher-profiles'),
  syncJoin: (invite, launcher, options) => ipcRenderer.invoke('sync-join', invite, launcher, options),
  syncStart: (key) => ipcRenderer.invoke('sync-start', key),
  syncLauncher: (key) => ipcRenderer.invoke('sync-launcher', key),
  syncNow: (key) => ipcRenderer.invoke('sync-now', key),
  syncToggle: (key, enabled) => ipcRenderer.invoke('sync-toggle', key, enabled),
  syncLeave: (key) => ipcRenderer.invoke('sync-leave', key),
  onSyncChanged: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('sync-changed', listener);
    return () => ipcRenderer.removeListener('sync-changed', listener);
  },
  onUpdateStatus:(callback)=>{
    const listener=(_,status)=>callback(status);ipcRenderer.on('update-status',listener);
    return ()=>ipcRenderer.removeListener('update-status',listener);
  },

  // 외부 브라우저로 URL 열기
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 수동 업데이트 확인 (결과는 네이티브 다이얼로그로 표시됨)
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // Electron 여부 확인 (UI에서 분기 처리용)
  isElectron: true,
});
