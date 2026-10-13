'use strict';
const fs=require('fs-extra');
const path=require('path');
const os=require('os');
const {regularFile}=require('./pack-utils');

async function findLauncher(launcher,{env=process.env,home=os.homedir()}={}) {
  const local=env.LOCALAPPDATA||path.join(home,'AppData','Local');
  const pf=env.ProgramFiles||'C:\\Program Files', x86=env['ProgramFiles(x86)']||'C:\\Program Files (x86)';
  const candidates={official:[path.join(x86,'Minecraft Launcher','MinecraftLauncher.exe'),path.join(pf,'Minecraft Launcher','MinecraftLauncher.exe'),path.join(local,'Programs','Minecraft Launcher','MinecraftLauncher.exe')],
    curseforge:[path.join(pf,'CurseForge','CurseForge.exe'),path.join(local,'Programs','CurseForge','CurseForge.exe')],
    modrinth:[path.join(local,'Modrinth App','Modrinth App.exe'),path.join(local,'Programs','Modrinth App','Modrinth App.exe'),path.join(pf,'Modrinth App','Modrinth App.exe')]};
  for(const file of candidates[launcher]||[])if(await fs.pathExists(file))return file;
  return null;
}
async function openLauncher(sub,{openPath,select,save}) {
  let target=sub.launchPath || await findLauncher(sub.launcher);
  if(!target || !await fs.pathExists(target))target=await select();
  if(!target)return {launched:false,message:'모드 적용 완료. 런처 연결을 선택하면 실행할 수 있습니다.'};
  if(!/\.(exe|lnk)$/i.test(target))throw Error('런처 실행 파일 또는 해당 게임 프로필의 바로가기를 선택하세요.');
  await regularFile(target);
  const error=await openPath(target);
  if(error)throw Error(`런처 실행 실패: ${error}`);
  await save(target);
  return {launched:true,message:'모드와 공용 설정 적용 완료. 열린 런처에서 연결한 게임 프로필의 플레이를 누르세요.'};
}
module.exports={findLauncher,openLauncher};
