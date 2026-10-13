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
  ipcMain.handle('owner-token',()=>service.getOwnerToken());
  ipcMain.handle('sync-list',()=>[]);
  ipcMain.handle('launcher-profiles',()=>[{key:'a'.repeat(32),name:'촬영 게임',minecraft:'26.3',loader:'fabric',loaderVersion:'0.18.4',launcher:'official'}]);
  const window=new BrowserWindow({show:false,width:1440,height:940,webPreferences:{preload:process.env.DEVKIT_TEST_ASAR ? path.join(process.env.DEVKIT_TEST_ASAR,'preload.js') : path.resolve(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false}});
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
  await capture('filming.png');
  await window.webContents.executeJavaScript('closeProfileWorkspace();openJoinModal()');
  await capture('join.png');
  await waitFor('document.getElementById("joinProfile").options.length === 2');
  await window.webContents.executeJavaScript('renderSubscriptions([{key:"test",name:"촬영 서버",minecraft:"26.3",loader:"fabric",syncConfig:true,enabled:true,status:"pending",message:"게임 시작 시 승인 배포를 자동 적용합니다.",modsDir:"C:/Games/Creator/mods"}])');
  if(!await window.webContents.executeJavaScript('document.querySelector(".game-start").textContent.includes("게임 시작")'))throw Error('Participant play button missing');
  await window.webContents.executeJavaScript('closeJoinModal();openProfileWorkspace("tab-team")');
  await capture('team.png');
  await window.webContents.executeJavaScript('openSrvPropModal()');
  await capture('properties.png');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('Renderer smoke test passed: owner auth, settings, review/approve/filming, launcher profiles and participant play button.');
  window.destroy();
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(server)await server.shutdown();
  app.exit(process.exitCode || 0);
});
