'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs-extra'),path=require('path'),os=require('os'),crypto=require('crypto');
const {neoMinecraft,loaderVersions,installerInfo,ensureRuntime,launchTarget}=require('../core/forge-runtime');
const BuildWatcher=require('../core/build-watcher');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'devkit-forge-'));t.after(()=>fs.remove(root));return root;}
const metadata=versions=>`<metadata><versioning><versions>${versions.map(v=>`<version>${v}</version>`).join('')}</versions></versioning></metadata>`;
test('NeoForge mapping separates 1.21, 1.21.1, 26.1 and 26.1.2 and excludes beta builds',()=>{
  for(const [v,mc] of [['21.0.100','1.21'],['21.1.200','1.21.1'],['26.1.0.12','26.1'],['26.1.2.90','26.1.2'],['26.3.0.76','26.3']])assert.equal(neoMinecraft(v),mc);
  assert.equal(neoMinecraft('26.3.0.75-beta'),null);
});
test('Forge recommendations and exact version pin use official Maven artifacts',async()=>{
  const get=async url=>({data:url.includes('promotions_slim')?{promos:{'1.21.1-recommended':'52.1.0'}}:metadata(['1.21.1-52.1.18','1.21.1-52.1.0','1.21.4-54.0.0'])});
  assert.equal((await installerInfo('forge','1.21.1','',{get})).version,'52.1.0');
  assert.equal((await installerInfo('forge','1.21.1','52.1.18',{get})).version,'52.1.18');
  await assert.rejects(installerInfo('forge','1.21.1','99.0.0',{get}),/없습니다/);
  const neo=await loaderVersions('neoforge','26.1.2',{get:async()=>({data:metadata(['26.1.0.12','26.1.2.3','26.1.2.22','26.1.2.99-beta'])})});assert.deepEqual(neo.map(v=>v.version),['26.1.2.22','26.1.2.3']);
});
test('Forge and NeoForge install the official args launch target, preserve worlds and mods, and restore failed installs',async t=>{
  const root=await fixture(t),binary=Buffer.from('official installer'),checksum=crypto.createHash('sha1').update(binary).digest('hex');
  for(const [type,version] of [['forge','52.1.0'],['neoforge','21.1.200']]){
    const dir=path.join(root,type);await fs.outputFile(path.join(dir,'world','data'),'world');await fs.outputFile(path.join(dir,'mods','creator.jar'),'mod');
    const artifact=type==='forge'?`1.21.1-${version}`:version,family=type==='forge'?'net/minecraftforge/forge':'net/neoforged/neoforge';
    const get=async url=>({data:url.endsWith('.sha1')?checksum:url.endsWith('.jar')?binary:url.includes('promotions_slim')?{promos:{}}:metadata([artifact])});
    let installs=0;
    const run=async(java,args,stage)=>{installs++;assert.deepEqual(args,['-jar','installer.jar','--installServer']);await fs.outputFile(path.join(stage,'libraries',family,artifact,'win_args.txt'),'-cp libraries/*');await fs.writeFile(path.join(stage,'run.bat'),'java @args');};
    const result=await ensureRuntime(dir,type,'1.21.1',version,'java',()=>{},{get,run});assert.equal(result.target.kind,'args');assert.ok(result.target.path.endsWith('/win_args.txt'));
    await ensureRuntime(dir,type,'1.21.1',version,'java',()=>{},{get,run});assert.equal(installs,1);
    await assert.rejects(ensureRuntime(dir,type,'1.21.1',version,'java',()=>{},{get,run:async()=>{throw Error('offline');},force:true}),/offline/);
    assert.equal(await fs.readFile(path.join(dir,'world','data'),'utf8'),'world');assert.equal(await fs.readFile(path.join(dir,'mods','creator.jar'),'utf8'),'mod');assert.equal((await fs.readJson(path.join(dir,`.${type}-runtime.json`))).version,version);
    await assert.rejects(ensureRuntime(dir,type,'1.21.1',version,'java',()=>{},{force:true,run,get:async url=>({data:url.endsWith('.sha1')?'0'.repeat(40):(await get(url)).data})}),/체크섬/);
  }
});
test('Forge and NeoForge build artifacts are routed to mods',async t=>{
  const root=await fixture(t);
  for(const file of ['mods.toml','neoforge.mods.toml']){await fs.outputFile(path.join(root,'src','main','resources','META-INF',file),'mod');const watcher=new BuildWatcher({projectDir:root,serverType:file.startsWith('neo')?'neoforge':'forge'},null,()=>{});assert.equal(await watcher._detectArtifactKind(),'mod');await fs.remove(path.join(root,'src'));}
});
