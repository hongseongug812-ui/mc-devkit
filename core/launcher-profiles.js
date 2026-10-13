'use strict';
const fs=require('fs-extra');
const path=require('path');
const os=require('os');
const {sha256,safeDirectory,regularFile}=require('./pack-utils');

async function read(file) {
  try { const stat=await regularFile(file); if(stat.size>2*1024*1024)return null; return await fs.readJson(file); } catch {return null;}
}
function loaderFrom(id='',libraries=[]) {
  const text=[id,...libraries.map(l=>l.name||'')].join(' ');
  for(const [loader,rx] of [['fabric',/(?:fabric-loader[-:]|fabricloader[-:]|fabric[-:])(\d+\.\d+(?:\.\d+)?)/i],['neoforge',/neoforge[-:](\d+\.\d+(?:\.\d+)?)/i],['forge',/(?:minecraftforge:forge:|forge[-:])([\d.-]+)/i]]) {
    const m=text.match(rx);if(m)return {loader,loaderVersion:loader==='forge'?m[1].replace(/^\d+\.\d+(?:\.\d+)?-/,''):m[1]};
  }
  return {loader:'none',loaderVersion:''};
}
async function versionInfo(root,id,seen=new Set()) {
  if(!id || /[\\/<>:]/.test(id) || seen.has(id) || seen.size>8)return {};
  seen.add(id);
  const meta=await read(path.join(root,'versions',id,`${id}.json`));
  if(!meta)return {minecraft:/^\d+\.\d+(\.\d+)?$/.test(id)?id:'',...loaderFrom(id)};
  const parent=meta.inheritsFrom?await versionInfo(root,meta.inheritsFrom,seen):{};
  const own=loaderFrom(id,meta.libraries||[]);
  return {minecraft:parent.minecraft || (/^\d+\.\d+(\.\d+)?$/.test(meta.id)?meta.id:''),
    ...(own.loader==='none' && parent.loader?{loader:parent.loader,loaderVersion:parent.loaderVersion}:own)};
}
async function detectInstance(instanceDir,launcher='other',hint={}) {
  await safeDirectory(instanceDir);
  const cf=await read(path.join(instanceDir,'minecraftinstance.json'));
  if(cf) {
    const base=cf.baseModLoader||{}, raw=base.name||'';
    return {minecraft:cf.gameVersion || base.minecraftVersion || cf.installedModpack?.gameVersion || '',
      ...loaderFrom(raw),launcher:'curseforge',name:cf.name||path.basename(instanceDir)};
  }
  const mr=await read(path.join(instanceDir,'profile.json'));
  if(mr) {const m=mr.metadata||mr;return {minecraft:m.game_version||m.gameVersion||'',loader:(m.loader||'none').toLowerCase(),loaderVersion:m.loader_version||m.loaderVersion||'',launcher:'modrinth',name:m.name||path.basename(instanceDir)};}
  const mm=await read(path.join(path.dirname(instanceDir),'mmc-pack.json')) || await read(path.join(instanceDir,'mmc-pack.json'));
  if(mm) {
    const game=mm.components?.find(c=>c.uid==='net.minecraft'), load=mm.components?.find(c=>/fabric|forge/.test(c.uid));
    return {minecraft:game?.version||'',loader:load?(load.uid.includes('neoforge')?'neoforge':load.uid.includes('fabric')?'fabric':'forge'):'none',loaderVersion:load?.version||'',launcher:'other'};
  }
  if(hint.versionRoot && hint.versionId) {
    let versionId=hint.versionId;
    if(hint.profileId) {
      const profiles=await read(path.join(hint.versionRoot,'launcher_profiles.json')) || await read(path.join(hint.versionRoot,'launcher_profiles_microsoft_store.json'));
      const profile=profiles?.profiles?.[hint.profileId];
      if(!profile || path.resolve(profile.gameDir||hint.versionRoot).toLowerCase()!==path.resolve(instanceDir).toLowerCase())throw Error('연결한 공식 런처 프로필이 변경됐습니다. 다시 참가하세요.');
      versionId=profile.lastVersionId;
    }
    return {...await versionInfo(hint.versionRoot,versionId),launcher};
  }
  return {minecraft:'',loader:'',loaderVersion:'',launcher};
}
async function discoverProfiles({appData=process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),home=os.homedir(),roots={}}={}) {
  const result=[];
  const add=async row=>{try {await safeDirectory(row.instanceDir);result.push({...row,key:sha256(JSON.stringify([row.launcher,row.instanceDir,row.profileId||row.name])).slice(0,32)});}catch{}};
  const official=roots.official || path.join(appData,'.minecraft');
  const launch=await read(path.join(official,'launcher_profiles.json')) || await read(path.join(official,'launcher_profiles_microsoft_store.json'));
  for(const [id,p] of Object.entries(launch?.profiles||{}).slice(0,200)) {
    if(!p.lastVersionId)continue;
    await add({name:p.name||id,launcher:'official',profileId:id,instanceDir:path.resolve(p.gameDir||official),versionRoot:official,versionId:p.lastVersionId,...await versionInfo(official,p.lastVersionId)});
  }
  for(const [launcher,dir] of [['curseforge',roots.curseforge||path.join(home,'curseforge','minecraft','Instances')],['modrinth',roots.modrinth||path.join(appData,'com.modrinth.theseus','profiles')]]) {
    const names=await fs.readdir(dir).catch(()=>[]);
    for(const n of names.slice(0,200)) {const instanceDir=path.join(dir,n);try{await add({instanceDir,launcher,...await detectInstance(instanceDir,launcher)});}catch{}}
  }
  return result;
}
function assertEnvironment(actual,manifest,{acknowledged=false}={}) {
  if(!actual.minecraft || !actual.loader) {
    if(!acknowledged)throw Error('게임 환경을 자동 확인할 수 없습니다. 런처에서 버전과 로더를 확인한 뒤 ‘직접 확인’ 옵션을 선택하세요.');
    return false;
  }
  if(actual.minecraft!==manifest.minecraft || actual.loader!==manifest.loader)throw Error(`게임 환경 불일치: ${actual.minecraft} / ${actual.loader}. 필요한 환경: ${manifest.minecraft} / ${manifest.loader}`);
  if(manifest.loaderVersion && actual.loaderVersion!==manifest.loaderVersion)throw Error(`로더 버전 불일치: 필요한 버전 ${manifest.loaderVersion}, 설치된 버전 ${actual.loaderVersion||'확인 불가'}`);
  return true;
}
module.exports={discoverProfiles,detectInstance,assertEnvironment,versionInfo,loaderFrom};
