'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs-extra'),path=require('path'),os=require('os');
const Studio=require('../core/studio-publisher');
const {ModSync,installManifest}=require('../core/mod-sync');
const {inspectPack,versionMatches}=require('../core/mod-inspector');
const {discoverProfiles,assertEnvironment}=require('../core/launcher-profiles');
const {openLauncher}=require('../core/game-launcher');
const {fabric,zip}=require('./jar-fixture');
const {sha256,revisionOf,validPackPath}=require('../core/pack-utils');
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'devkit-studio-'));t.after(()=>fs.remove(root));
  const publisher=new Studio(path.join(root,'host'));t.after(()=>publisher.close());
  let channel=await publisher.channel({serverDir:root,serverFolder:'shoot',serverType:'fabric',paperVersion:'26.3'},'촬영');
  channel=await publisher.configure(channel,{loaderVersion:'0.18.4',autoPublish:false});
  await fs.ensureDir(channel.sourceDir);
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),fabric());
  return {root,publisher,channel};
}
async function approve(publisher,channel){await publisher.publish(channel);const p=await publisher.pending(channel.id);return publisher.promote(channel.id,p.manifest.revision);}
test('review stages immutable changes; filming survives restart; restore redistributes approved bytes',async t=>{
  const {root,publisher,channel}=await fixture(t);
  await publisher.publish(channel);assert.equal(await publisher.manifest(channel.id).catch(()=>null),null);
  const first=await approve(publisher,channel);
  await publisher.setMode(channel.id,'filming');
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),fabric('2.0.0'));await publisher.publish(channel);
  const pending=await publisher.pending(channel.id);assert.notEqual(pending.manifest.revision,first.revision);
  await assert.rejects(publisher.promote(channel.id,pending.manifest.revision),/촬영/);
  await publisher.close();const restart=new Studio(path.join(root,'host'));t.after(()=>restart.close());await restart.init();
  assert.equal((await restart.view(channel)).pinnedRevision,first.revision);
  assert.equal((await restart.manifest(channel.id)).revision,first.revision);
  await restart.setMode(channel.id,'review');await restart.promote(channel.id,pending.manifest.revision);
  const restored=await restart.restore(channel.id,first.revision);
  assert.equal(restored.revision,first.revision);assert.equal((await restart.readChannel(channel.id)).mode,'review');
  assert.deepEqual(await fs.readFile(await restart.object(channel.id,first.files[0].sha256)),fabric());
});
test('auto mode rejects invalid metadata and empty removal; approved object cannot change with source',async t=>{
  const {publisher,channel}=await fixture(t);
  const auto=await publisher.configure(channel,{mode:'auto',autoPublish:false});
  const first=await publisher.publish(auto);assert.equal((await publisher.manifest(channel.id)).revision,first.revision);
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),fabric('2.0.0',{depends:{missing:'*'}}));await publisher.publish(auto);
  assert.ok((await publisher.pending(channel.id)).validation.errors.some(e=>e.includes('missing')));
  assert.equal((await publisher.manifest(channel.id)).revision,first.revision);
  await fs.remove(path.join(channel.sourceDir,'creator.jar'));await publisher.publish(auto);
  const empty=await publisher.pending(channel.id);await assert.rejects(publisher.promote(channel.id,empty.manifest.revision),/빈 배포/);
  assert.equal((await publisher.manifest(channel.id)).revision,first.revision);
  await publisher.promote(channel.id,empty.manifest.revision,true);assert.equal((await publisher.manifest(channel.id)).files.length,0);
});
test('metadata catches wrong game, wrong loader, duplicate IDs and missing dependencies; reads nested library JAR',async t=>{
  const {publisher,channel}=await fixture(t);
  const file=path.join(channel.sourceDir,'creator.jar');
  const inspect=async()=>inspectPack([{name:'creator.jar',path:file}],channel);
  await fs.writeFile(file,fabric('1.0.0',{depends:{minecraft:'<26',fabricloader:'>=0.19'}}));assert.equal((await inspect()).errors.length,2);
  await fs.writeFile(file,zip({'META-INF/mods.toml':'modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="test"\nversion="1.0.0"'}));assert.ok((await inspect()).errors.some(e=>e.includes('forge')));
  await fs.writeFile(file,zip({'fabric.mod.json':JSON.stringify({id:'creator',version:'1.0.0',depends:{minecraft:'26.3'}}),'META-INF/jars/library.jar':zip({'library.txt':'library'})}));assert.equal((await inspect()).errors.length,0);
  const same=await inspectPack([{name:'one.jar',path:file},{name:'two.jar',path:file}],channel);assert.ok(same.errors.some(e=>e.includes('중복')));
  assert.equal(versionMatches('47.1.0','[47,48)'),true);assert.equal(versionMatches('48.0.0','[47,48)'),false);
  await fs.writeFile(file,Buffer.from('not-a-jar'));assert.equal((await inspect()).errors.length,1);
});
test('selected configs require opt-in, back up existing settings and keep personal options unchanged',async t=>{
  const {root,publisher,channel}=await fixture(t);
  await fs.ensureDir(channel.configSourceDir);await fs.writeFile(path.join(channel.configSourceDir,'creator.toml'),'value = 1');
  const configured=await publisher.configure(channel,{configPatterns:['creator.toml'],autoPublish:false});
  const manifest=await approve(publisher,configured),mods=path.join(root,'game','mods'),config=path.join(root,'game','config');
  await fs.ensureDir(config);await fs.writeFile(path.join(config,'creator.toml'),'personal');await fs.writeFile(path.join(root,'game','options.txt'),'keybind');
  const download=f=>fs.readFile(publisher.file(channel.id,`objects/${f.sha256}`));
  assert.equal((await installManifest(mods,manifest,download,async()=>false)).status,'config-pending');
  assert.equal(await fs.readFile(path.join(config,'creator.toml'),'utf8'),'personal');
  const result=await installManifest(mods,manifest,download,async()=>false,{syncConfig:true});assert.equal(result.status,'updated');
  assert.equal(await fs.readFile(path.join(config,'creator.toml'),'utf8'),'value = 1');
  assert.equal(await fs.readFile(path.join(result.backupDir,'config','creator.toml'),'utf8'),'personal');
  assert.equal(await fs.readFile(path.join(root,'game','options.txt'),'utf8'),'keybind');
  await fs.writeFile(path.join(channel.configSourceDir,'token.json'),'secret');
  const unsafe=await publisher.configure(channel,{configPatterns:['*.json']});await assert.rejects(publisher.publish(unsafe),/個人|개인 설정/);
  for(const name of ['config/../x.toml','config/options.txt','config/keybind.json','config/account.json','config/foo/token.toml','mods/sub/test.jar'])assert.equal(validPackPath(name),false);
});
test('invites rotate and revoke; readiness follows revision and expires when disconnected',async t=>{
  const {publisher,channel}=await fixture(t),active=await approve(publisher,channel);
  await publisher.report(channel.id,{clientId:'a'.repeat(32),status:'current',name:'Actor',revision:active.revision});assert.equal((await publisher.participants(channel.id))[0].ready,true);
  await publisher.report(channel.id,{clientId:'a'.repeat(32),status:'current',revision:'b'.repeat(64)});assert.equal((await publisher.participants(channel.id))[0].ready,false);
  const rotated=await publisher.invite(channel.id,'rotate');assert.equal(await publisher.authorized(channel.id,channel.token),false);assert.equal(await publisher.authorized(channel.id,rotated.token),true);
  await publisher.invite(channel.id,'revoke');assert.equal(await publisher.authorized(channel.id,rotated.token),false);
  assert.equal(await publisher.authorized(channel.id,'가'.repeat(64)),false);
  const list=await fs.readJson(publisher.file(channel.id,'participants.json'));list['a'.repeat(32)].checkedAt=new Date(Date.now()-90000).toISOString();await fs.writeJson(publisher.file(channel.id,'participants.json'),list);assert.equal((await publisher.participants(channel.id))[0].online,false);
});
test('launcher profiles discover exact Minecraft and loader versions; changed official profile blocks start',async t=>{
  const {root}=await fixture(t),official=path.join(root,'official'),game=path.join(root,'instance');await fs.ensureDir(game);
  await fs.outputJson(path.join(official,'launcher_profiles.json'),{profiles:{shoot:{name:'촬영',lastVersionId:'fabric-loader-0.18.4-26.3',gameDir:game}}});
  await fs.outputJson(path.join(official,'versions','fabric-loader-0.18.4-26.3','fabric-loader-0.18.4-26.3.json'),{id:'fabric-loader-0.18.4-26.3',inheritsFrom:'26.3',libraries:[{name:'net.fabricmc:fabric-loader:0.18.4'}]});
  const curse=path.join(root,'curse');await fs.outputJson(path.join(curse,'Actor','minecraftinstance.json'),{name:'Actor',gameVersion:'26.3',baseModLoader:{name:'fabric-0.18.4'}});
  const mr=path.join(root,'mr');await fs.outputJson(path.join(mr,'Shoot','profile.json'),{metadata:{name:'Shoot',game_version:'26.3',loader:'fabric',loader_version:'0.18.4'}});
  const profiles=await discoverProfiles({roots:{official,curseforge:curse,modrinth:mr}});assert.equal(profiles.length,3);
  for(const p of profiles)assert.equal(assertEnvironment(p,{minecraft:'26.3',loader:'fabric',loaderVersion:'0.18.4'}),true);
  assert.throws(()=>assertEnvironment({minecraft:'1.21.1',loader:'fabric'},{minecraft:'26.3',loader:'fabric'}),/불일치/);
  assert.throws(()=>assertEnvironment({},{minecraft:'26.3',loader:'fabric'}),/직접 확인/);
});
test('game start applies before launcher, blocks failed downloads, and rechecks host revision',async t=>{
  const {root,publisher,channel}=await fixture(t);await approve(publisher,channel);
  const instance=path.join(root,'game');await fs.outputJson(path.join(instance,'minecraftinstance.json'),{gameVersion:'26.3',baseModLoader:{name:'fabric-0.18.4'}});
  let corrupted=false;
  const manager=new ModSync(path.join(root,'participant'),{isRunning:async()=>false,report:async()=>({}),request:async(url)=>({data:url.endsWith('/manifest')?await publisher.manifest(channel.id):corrupted?Buffer.from('bad'):await fs.readFile(await publisher.object(channel.id,url.split('/').pop()))})});t.after(()=>manager.close());
  await manager.join(`https://host.example/?join=${channel.id}#token=${channel.token}`,instance,'curseforge',{syncConfig:true});
  const key=manager.list()[0].key;assert.equal(await fs.pathExists(path.join(instance,'mods','creator.jar')),false);
  corrupted=true;let launches=0;await assert.rejects(manager.startGame(key,async()=>{launches++;}),/다운로드/);assert.equal(launches,0);
  corrupted=false;
  await manager.startGame(key,async()=>{assert.deepEqual(await fs.readFile(path.join(instance,'mods','creator.jar')),fabric());launches++;return {launched:true};});assert.equal(launches,1);
  await fs.writeJson(path.join(instance,'minecraftinstance.json'),{gameVersion:'1.21.1',baseModLoader:{name:'fabric-0.18.4'}});
  await assert.rejects(manager.startGame(key,async()=>{launches++;}),/환경 불일치/);assert.equal(launches,1);
});
test('launcher handoff reports cancellation and failure without claiming the game started',async t=>{
  const {root}=await fixture(t),file=path.join(root,'profile.lnk');await fs.writeFile(file,'shortcut');
  const sub={launcher:'other',launchPath:file};let saved=false;
  const result=await openLauncher(sub,{openPath:async()=>'',select:async()=>null,save:async()=>{saved=true;}});assert.equal(result.launched,true);assert.equal(saved,true);
  await assert.rejects(openLauncher(sub,{openPath:async()=>'failed',select:async()=>null,save:async()=>{}}),/실행 실패/);
  assert.equal((await openLauncher({launcher:'other'},{select:async()=>null})).launched,false);
});
