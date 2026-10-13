'use strict';
const fs=require('fs-extra'),path=require('path'),crypto=require('crypto'),axios=require('axios');
const {spawn}=require('child_process');
const {safeDirectory,regularFile,writeJsonAtomic}=require('./pack-utils');
const {USER_AGENT}=require('./versions');
const FORGE='https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEO='https://maven.neoforged.net/releases/net/neoforged/neoforge';
const requestOptions={headers:{'User-Agent':USER_AGENT},timeout:20000};
async function officialGet(url,options){
  for(let attempt=0;attempt<3;attempt++)try{return await axios.get(url,options);}catch(e){
    const retry=!e.response || [408,429,500,502,503,504].includes(e.response.status);
    if(!retry || attempt===2)throw Error(`공식 로더 서버 연결 실패${e.response?' (HTTP '+e.response.status+')':''}. 잠시 후 다시 시도하세요.`);
    await new Promise(r=>setTimeout(r,1000*(attempt+1)));
  }
}
function neoMinecraft(version){
  if(!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version))return null;
  const [major,minor,patch]=version.split('.').map(Number);
  if(major>=26)return `${major}.${minor}${patch?'.'+patch:''}`;
  return `1.${major}${minor?'.'+minor:''}`;
}
function parseMetadata(xml){return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map(m=>m[1]);}
function numericSort(a,b){const av=a.split('.').map(Number),bv=b.split('.').map(Number);for(let i=0;i<Math.max(av.length,bv.length);i++)if((bv[i]||0)!==(av[i]||0))return (bv[i]||0)-(av[i]||0);return 0;}
async function loaderVersions(type,minecraft,{get=officialGet}={}) {
  if(!['forge','neoforge'].includes(type))throw Error('지원하지 않는 로더');
  const base=type==='forge'?FORGE:NEO;
  const {data}=await get(`${base}/maven-metadata.xml`,requestOptions);
  const all=parseMetadata(data);
  if(type==='neoforge')return all.filter(v=>neoMinecraft(v)===minecraft).sort(numericSort).map(version=>({version,artifactVersion:version}));
  return all.filter(v=>v.startsWith(`${minecraft}-`) && /^[\d.]+-[\d.]+$/.test(v)).map(v=>({version:v.slice(minecraft.length+1),artifactVersion:v})).sort((a,b)=>numericSort(a.version,b.version));
}
async function gameVersions(type,{get=officialGet}={}) {
  const {data}=await get(`${type==='forge'?FORGE:NEO}/maven-metadata.xml`,requestOptions);
  return [...new Set(parseMetadata(data).map(v=>type==='forge'?v.match(/^([\d.]+)-[\d.]+$/)?.[1]:neoMinecraft(v)).filter(Boolean))];
}
async function installerInfo(type,minecraft,wanted='',{get=officialGet}={}) {
  if(!/^\d+\.\d+(\.\d+)?$/.test(minecraft) || !/^[\d.]*$/.test(wanted))throw Error('게임 및 로더 버전을 확인하세요.');
  const versions=await loaderVersions(type,minecraft,{get});
  let chosen=wanted?versions.find(v=>v.version===wanted):versions[0];
  if(!wanted && type==='forge'){
    const {data}=await get('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',requestOptions);
    chosen=versions.find(v=>v.version===data.promos?.[`${minecraft}-recommended`]) || chosen;
  }
  if(!chosen)throw Error(`${type} ${minecraft}의 요청한 안정 로더 버전이 없습니다.`);
  const base=type==='forge'?FORGE:NEO,artifact=type==='forge'?'forge':'neoforge';
  const url=`${base}/${chosen.artifactVersion}/${artifact}-${chosen.artifactVersion}-installer.jar`;
  return {...chosen,url,type,minecraft};
}
function launchTarget(root,info,platform=process.platform) {
  const family=info.type==='forge'?'net/minecraftforge/forge':'net/neoforged/neoforge';
  const args=`libraries/${family}/${info.artifactVersion}/${platform==='win32'?'win':'unix'}_args.txt`;
  if(fs.pathExistsSync(path.join(root,...args.split('/'))))return {kind:'args',path:args};
  if(fs.pathExistsSync(path.join(root,'forge-runtime.jar')))return {kind:'jar',path:'forge-runtime.jar'};
  const jar=fs.readdirSync(root).find(n=>n.startsWith(`forge-${info.artifactVersion}`) && n.endsWith('.jar') && !n.includes('installer'));
  if(jar)return {kind:'jar',path:jar};
  throw Error('로더 설치 결과에 서버 실행 파일이 없습니다. 설치 로그를 확인하세요.');
}
function runInstaller(java,args,dir,onLog){return new Promise((resolve,reject)=>{
  const child=spawn(java,args,{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>{child.kill();reject(Error('로더 설치 시간이 초과됐습니다. 연결을 확인하세요.'));},600000);
  for(const stream of ['stdout','stderr'])child[stream].on('data',d=>d.toString().split('\n').filter(Boolean).forEach(line=>onLog(line,stream)));
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`로더 설치 실패 (exit ${code})`));});
});}
async function recover(root,type){
  const file=path.join(root,`.${type}-transaction.json`);if(!await fs.pathExists(file))return;
  const journal=await fs.readJson(file);
  if(!/^[a-f0-9]{32}$/.test(journal.backup) || !Array.isArray(journal.files) || journal.files.some(f=>!['libraries','run.bat','run.sh','forge-runtime.jar',`.${type}-runtime.json`].includes(f.name) && !/^(?:minecraft_server\.[\d.]+|(?:forge|neoforge)-[\d.-]+(?:-shim)?)\.jar$/.test(f.name)))throw Error('서버 실행 파일 복구 기록이 잘못됐습니다.');
  const backup=await safeDirectory(path.join(root,'runtime-backups',journal.backup));
  for(const f of journal.files)if(f.existed && !await fs.pathExists(path.join(backup,f.name)))throw Error('서버 실행 파일 백업을 찾을 수 없습니다.');
  for(const f of journal.files){const dest=path.join(root,f.name);if(f.existed)await fs.copy(path.join(backup,f.name),dest,{overwrite:true});else await fs.remove(dest);}
  await fs.remove(file);
}
async function ensureRuntime(root,type,minecraft,wanted,java,onLog,{force=false,get=officialGet,run=runInstaller}={}) {
  await safeDirectory(root,true);await recover(root,type);
  const marker=path.join(root,`.${type}-runtime.json`);
  const saved=await fs.readJson(marker).catch(()=>null);
  if(!force && saved?.minecraft===minecraft && (!wanted || saved.version===wanted)) {
    const target=launchTarget(root,saved);await regularFile(path.join(root,...target.path.split('/')));return {...saved,target};
  }
  const info=await installerInfo(type,minecraft,wanted,{get});
  onLog(`[${type}] 공식 설치 파일 준비 · Minecraft ${minecraft} · ${info.version}`);
  const [{data:binary},{data:checksum}]=await Promise.all([get(info.url,{...requestOptions,responseType:'arraybuffer',timeout:120000,maxContentLength:MAX_INSTALLER}),get(`${info.url}.sha1`,requestOptions)]);
  const expected=String(checksum).trim().match(/^[a-f0-9]{40}/i)?.[0].toLowerCase();
  if(!expected || crypto.createHash('sha1').update(Buffer.from(binary)).digest('hex')!==expected)throw Error('공식 로더 설치 파일 체크섬 검증 실패');
  const stage=path.join(root,`.mc-devkit-${type}-stage-${crypto.randomBytes(8).toString('hex')}`);await fs.mkdir(stage);
  try {
    await fs.writeFile(path.join(stage,'installer.jar'),binary);await run(java,['-jar','installer.jar','--installServer'],stage,(line,stream)=>onLog(`[${type}] ${line}`,stream));
    let target=launchTarget(stage,info);
    if(target.kind==='jar'){await fs.rename(path.join(stage,target.path),path.join(stage,'forge-runtime.jar'));target={kind:'jar',path:'forge-runtime.jar'};}
    await writeJsonAtomic(path.join(stage,`.${type}-runtime.json`),{...info,target,installedAt:new Date().toISOString()});
    const files=['libraries','run.bat','run.sh',...(target.kind==='jar'?['forge-runtime.jar']:[]),...fs.readdirSync(stage).filter(n=>/^(?:minecraft_server\.[\d.]+|(?:forge|neoforge)-[\d.-]+(?:-shim)?)\.jar$/.test(n)),`.${type}-runtime.json`].filter(n=>fs.pathExistsSync(path.join(stage,n)));
    const backup=crypto.randomBytes(16).toString('hex'),backupDir=await safeDirectory(path.join(root,'runtime-backups',backup),true),journal={backup,files:[]};
    for(const name of files){const dest=path.join(root,name),existed=await fs.pathExists(dest);if(existed){if(name==='libraries')await safeDirectory(dest);else await regularFile(dest);await fs.copy(dest,path.join(backupDir,name));}journal.files.push({name,existed});}
    await writeJsonAtomic(path.join(root,`.${type}-transaction.json`),journal);
    try {
      for(const name of files)await fs.copy(path.join(stage,name),path.join(root,name),{overwrite:true});
      await fs.remove(path.join(root,`.${type}-transaction.json`));
    }catch(e){await recover(root,type);throw e;}
    onLog(`[${type}] 서버 설치 완료 · 실행 파일 백업: ${backupDir}`);
    return {...info,target};
  }finally{await fs.remove(stage);}
}
const MAX_INSTALLER=32*1024*1024;
module.exports={loaderVersions,gameVersions,installerInfo,neoMinecraft,parseMetadata,launchTarget,ensureRuntime,recover};
