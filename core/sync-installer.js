'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { gameRunning } = require('./game-process');
const { MAX_FILE, MAX_PACK, hashFile, regularFile, safeDirectory, validPackPath,
  validateManifest, revisionOf, writeJsonAtomic, packPath } = require('./pack-utils');
const STATE = '.mc-devkit-sync.json', JOURNAL = '.mc-devkit-transaction.json';

async function readState(modsDir) {
  const file = path.join(modsDir, STATE);
  if (!await fs.pathExists(file)) return null;
  await regularFile(file);
  return validateManifest(await fs.readJson(file));
}

async function destination(root, name, create = true) {
  if (!validPackPath(name)) throw Error('안전하지 않은 배포 경로');
  const file = path.join(root, ...name.split('/'));
  await safeDirectory(path.dirname(file), create);
  if (await fs.pathExists(file)) await regularFile(file);
  return file;
}

async function rollback(modsDir, journal) {
  if (!/^[a-f0-9]{32}$/.test(journal.backup) || !Array.isArray(journal.files) || journal.files.length > 1000
    || journal.files.some(f => !validPackPath(journal.schema === 2 ? f.name : `mods/${f.name}`) || typeof f.existed !== 'boolean')) throw Error('복구 기록을 확인할 수 없습니다. 백업 폴더를 확인하세요.');
  const root = path.dirname(modsDir);
  const backupDir = await safeDirectory(path.join(modsDir, '.mc-devkit-backups', journal.backup));
  // Validate every backup before starting the recovery itself.
  for (const f of journal.files) if (f.existed) {
    const source = path.join(backupDir, ...f.name.split('/'));
    await safeDirectory(path.dirname(source)); await regularFile(source);
  }
  for (const f of journal.files) {
    const dest = await destination(root, journal.schema === 2 ? f.name : `mods/${f.name}`);
    if (f.existed) await fs.copyFile(path.join(backupDir, ...f.name.split('/')), dest);
    else await fs.remove(dest);
  }
  if (journal.before) await writeJsonAtomic(path.join(modsDir, STATE), validateManifest(journal.before));
  else await fs.remove(path.join(modsDir, STATE));
  await fs.remove(path.join(modsDir, JOURNAL));
}

async function installManifest(modsDir, input, download, isRunning = gameRunning, { syncConfig = false } = {}) {
  validateManifest(input);
  modsDir = await safeDirectory(modsDir, true);
  const root = path.dirname(modsDir);
  if (await isRunning()) return { status: 'waiting', message: 'Minecraft를 종료한 뒤 게임 시작을 다시 누르세요.' };
  if (await fs.pathExists(path.join(modsDir,JOURNAL))) {
    await regularFile(path.join(modsDir,JOURNAL)); await rollback(modsDir,await fs.readJson(path.join(modsDir,JOURNAL)));
  }
  const before = await readState(modsDir);
  if (before && before.id !== input.id) throw Error('다른 서버 모드팩이 연결된 게임 폴더입니다. 별도 인스턴스를 선택하세요.');
  const configSkipped = input.files.some(f=>packPath(f,input).startsWith('config/')) && !syncConfig;
  const manifest = { ...input, files: input.files.filter(f=>syncConfig || !packPath(f,input).startsWith('config/')) };
  manifest.revision = revisionOf(manifest);
  const oldFiles = new Map((before?.files || []).map(f=>[packPath(f,before).toLowerCase(),f]));
  const newFiles = new Map(manifest.files.map(f=>[packPath(f,manifest).toLowerCase(),f]));
  const changed=[], removed=[], observations=new Map();
  for (const file of manifest.files) {
    const name=packPath(file,manifest), dest=await destination(root,name), key=name.toLowerCase();
    const siblings=await fs.readdir(path.dirname(dest));
    if(siblings.some(n=>n.toLowerCase()===path.basename(dest).toLowerCase() && n!==path.basename(dest))) throw Error(`대소문자가 다른 파일이 있습니다: ${name}`);
    if(await fs.pathExists(dest)) {
      const hash=await hashFile(dest);observations.set(key,hash);
      if(name.startsWith('mods/')) {
        if(!oldFiles.has(key))throw Error(`개인 모드와 이름이 겹칩니다: ${name}. 새 인스턴스를 사용하거나 파일을 옮기세요.`);
        if(hash!==oldFiles.get(key).sha256)throw Error(`직접 수정한 모드를 보호하기 위해 중지했습니다: ${name}`);
      }
      if(hash===file.sha256)continue;
    } else observations.set(key,null);
    changed.push({ ...file, name });
  }
  for(const file of before?.files || []) {
    const name=packPath(file,before), key=name.toLowerCase();
    if(newFiles.has(key) || (!syncConfig && name.startsWith('config/')))continue;
    const dest=await destination(root,name);
    if(await fs.pathExists(dest)) {
      const hash=await hashFile(dest);
      if(hash!==file.sha256)throw Error(`직접 수정한 파일을 보호하기 위해 제거를 중지했습니다: ${name}`);
      observations.set(key,hash);removed.push({ ...file,name });
    }
  }
  // Retain ownership of previously synced configs while the participant pauses config syncing.
  if(!syncConfig && before) for(const f of before.files) if(packPath(f,before).startsWith('config/')) {
    if(manifest.schema!==2)throw Error('공용 설정이 있는 인스턴스에 이전 형식의 배포를 적용할 수 없습니다.');
    manifest.files.push({ ...f,name:packPath(f,before) });
  }
  manifest.revision=revisionOf(manifest);
  const result=(updated,backupDir)=>({status:configSkipped?'config-pending':updated?'updated':'current',
    message:configSkipped?'모드 적용 완료. 공용 설정 동기화를 켜야 게임을 시작할 수 있습니다.':updated?`${changed.length}개 적용 · ${removed.length}개 제거. 게임을 시작할 수 있습니다.`:'현재 승인된 배포가 적용되어 있습니다.',
    revision:configSkipped?null:input.revision,...(backupDir?{backupDir}:{})});
  if(!changed.length && !removed.length && before?.revision===manifest.revision)return result(false);
  const stage=path.join(modsDir,`.mc-devkit-stage-${crypto.randomBytes(16).toString('hex')}`);await fs.mkdir(stage);
  try {
    let total=0;
    for(const file of changed) {
      const data=await download(input.schema===1?{...file,name:path.basename(file.name)}:file);total+=data.length;
      if(data.length!==file.size || data.length>MAX_FILE || total>MAX_PACK)throw Error(`다운로드 크기 불일치: ${file.name}`);
      const target=await destination(stage,file.name);await fs.writeFile(target,data);
      if(await hashFile(target)!==file.sha256)throw Error(`다운로드 해시 검증 실패: ${file.name}`);
    }
    if(await isRunning())return {status:'waiting',message:'게임이 실행되어 적용을 보류했습니다. 종료 후 다시 시작하세요.'};
    for(const file of [...changed,...removed]) {
      const dest=await destination(root,file.name);const now=await fs.pathExists(dest)?await hashFile(dest):null;
      if(now!==observations.get(file.name.toLowerCase()))throw Error(`다운로드 중 파일이 변경됐습니다: ${file.name}`);
    }
    const backup=crypto.randomBytes(16).toString('hex'), backupDir=await safeDirectory(path.join(modsDir,'.mc-devkit-backups',backup),true);
    const journal={schema:2,backup,before,files:[]};
    for(const file of [...changed,...removed]) {
      const dest=await destination(root,file.name), existed=await fs.pathExists(dest);
      if(existed)await fs.copyFile(dest,await destination(backupDir,file.name));
      journal.files.push({name:file.name,existed});
    }
    await writeJsonAtomic(path.join(backupDir,'previous-manifest.json'),before);
    await writeJsonAtomic(path.join(modsDir,JOURNAL),journal);
    try {
      for(const file of removed)await fs.remove(await destination(root,file.name));
      for(const file of changed)await fs.copyFile(path.join(stage,...file.name.split('/')),await destination(root,file.name));
      await writeJsonAtomic(path.join(modsDir,STATE),manifest);await fs.remove(path.join(modsDir,JOURNAL));
    } catch(error) {await rollback(modsDir,journal);throw error;}
    return result(true,backupDir);
  } finally {await fs.remove(stage);}
}

module.exports={installManifest,readState,rollback};
