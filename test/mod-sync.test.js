'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const PackPublisher = require('../core/pack-publisher');
const { ModSync, installManifest, parseInvite } = require('../core/mod-sync');
const { sha256, revisionOf, validateManifest } = require('../core/pack-utils');
const { requiredJava, sortVersions } = require('../core/versions');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devkit-sync-test-'));
  t.after(() => fs.remove(root));
  const publisher = new PackPublisher(path.join(root, 'host'));
  t.after(() => publisher.close());
  const config = { serverDir: root, serverFolder: 'shoot', serverType: 'fabric', paperVersion: '26.3' };
  const channel = await publisher.channel(config, '촬영 서버');
  await fs.ensureDir(channel.sourceDir);
  return { root, publisher, config, channel, mods: path.join(root, 'client', 'mods') };
}
const closed = async () => false;
async function download(publisher, channel, file) { return fs.readFile(await publisher.object(channel.id, file.sha256)); }

test('release sorting and Java support cover calendar versions and legacy versions', () => {
  assert.deepEqual(sortVersions(['1.21.4','26.3','1.21.11','26.3-rc1','26.1.2','1.21.4']), ['26.3','26.1.2','1.21.11','1.21.4']);
  for (const [version, java] of [['26.3',25],['26.1',25],['1.21.11',21],['1.20.5',21],['1.20.4',17],['1.17.1',16],['1.16.5',8]]) assert.equal(requiredJava(version), java);
});

test('server and Minecraft version allocate separate distribution channels', async t => {
  const { publisher, config, channel } = await fixture(t);
  assert.equal((await publisher.channel(config)).id, channel.id);
  assert.notEqual((await publisher.channel({ ...config, paperVersion: '1.21.11' })).id, channel.id);
  assert.notEqual((await publisher.channel({ ...config, serverFolder: 'other' })).id, channel.id);
  assert.equal(await publisher.authorized(channel.id, channel.token), true);
  assert.equal(await publisher.authorized(channel.id, 'x'.repeat(64)), false);
});

test('host change replaces managed mods, removes obsolete versions, preserves personal mods and backups', async t => {
  const { publisher, channel, mods } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir, 'creator-v1.jar'), 'v1');
  const first = await publisher.publish(channel);
  assert.equal((await installManifest(mods, first, f => download(publisher,channel,f),closed)).status,'updated');
  await fs.writeFile(path.join(mods,'personal.jar'),'personal');
  await fs.remove(path.join(channel.sourceDir,'creator-v1.jar'));
  await fs.writeFile(path.join(channel.sourceDir,'creator-v2.jar'),'v2');
  const next = await publisher.publish(channel);
  const result = await installManifest(mods,next,f => download(publisher,channel,f),closed);
  assert.equal(await fs.pathExists(path.join(mods,'creator-v1.jar')),false);
  assert.equal(await fs.readFile(path.join(mods,'creator-v2.jar'),'utf8'),'v2');
  assert.equal(await fs.readFile(path.join(mods,'personal.jar'),'utf8'),'personal');
  assert.equal(await fs.readFile(path.join(result.backupDir,'mods','creator-v1.jar'),'utf8'),'v1');
  assert.equal((await installManifest(mods,next,() => { throw Error('should not download'); },closed)).status,'current');
});

test('bad downloads and interrupted downloads leave all installed mods untouched', async t => {
  const { publisher, channel, mods } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'a.jar'),'before');
  const first = await publisher.publish(channel);
  await installManifest(mods,first,f => download(publisher,channel,f),closed);
  await fs.writeFile(path.join(channel.sourceDir,'a.jar'),'after!');
  await fs.writeFile(path.join(channel.sourceDir,'b.jar'),'new');
  const next = await publisher.publish(channel);
  await assert.rejects(installManifest(mods,next,async () => Buffer.from('broken'),closed), /검증 실패/);
  assert.equal(await fs.readFile(path.join(mods,'a.jar'),'utf8'),'before');
  await assert.rejects(installManifest(mods,next,async f => { if(f.name==='b.jar') throw Error('offline'); return download(publisher,channel,f); },closed), /offline/);
  assert.equal(await fs.pathExists(path.join(mods,'b.jar')),false);
  assert.equal((await fs.readJson(path.join(mods,'.mc-devkit-sync.json'))).revision,first.revision);
});

test('game running defers application and a game opening during download also defers', async t => {
  const { publisher,channel,mods } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'a.jar'),'a');
  const manifest = await publisher.publish(channel);
  assert.equal((await installManifest(mods,manifest,() => { throw Error('download forbidden'); },async () => true)).status,'waiting');
  let checks = 0;
  assert.equal((await installManifest(mods,manifest,f=>download(publisher,channel,f),async () => ++checks>1)).status,'waiting');
  assert.equal(await fs.pathExists(path.join(mods,'a.jar')),false);
});

test('unmanaged name conflicts, modified managed files and other channels are protected', async t => {
  const { publisher,channel,mods,config } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'a.jar'),'a');
  const manifest = await publisher.publish(channel);
  await fs.ensureDir(mods);
  await fs.writeFile(path.join(mods,'a.jar'),'personal');
  await assert.rejects(installManifest(mods,manifest,f=>download(publisher,channel,f),closed), /개인 모드/);
  await fs.remove(path.join(mods,'a.jar'));
  await installManifest(mods,manifest,f=>download(publisher,channel,f),closed);
  await fs.writeFile(path.join(mods,'a.jar'),'edited');
  await assert.rejects(installManifest(mods,manifest,f=>download(publisher,channel,f),closed), /직접 수정/);
  const other = await publisher.channel({ ...config,serverFolder:'another' });
  const second = await publisher.publish(other);
  await assert.rejects(installManifest(mods,second,async()=>Buffer.alloc(0),closed), /다른 서버/);
});

test('manifest rejects traversal, duplicate filenames, wrong hashes and invalid sizes', () => {
  const good = { schema:1,id:'a'.repeat(32),name:'test',minecraft:'26.3',loader:'fabric',files:[{name:'test.jar',size:1,sha256:sha256('a')}] };
  good.revision = revisionOf(good);
  validateManifest(good);
  for (const name of ['../bad.jar','bad\\evil.jar','CON.jar','.hidden.jar','bad:ads.jar']) {
    const m={...good,files:[{...good.files[0],name}]};m.revision=revisionOf(m);
    assert.throws(()=>validateManifest(m),/잘못된/);
  }
  const duplicate={...good,files:[good.files[0],{...good.files[0],name:'TEST.jar'}]};duplicate.revision=revisionOf(duplicate);
  assert.throws(()=>validateManifest(duplicate),/잘못된/);
});

test('client joins once, persists subscriptions, syncs changes and pause/leave keep installed files', async t => {
  const { publisher,channel,root } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),'1');
  await publisher.publish(channel);
  const request = async (url, options) => {
    assert.equal(options.headers['X-Pack-Token'],channel.token);
    if(url.endsWith('/manifest')) return {data:await publisher.manifest(channel.id)};
    return {data:await fs.readFile(await publisher.object(channel.id,url.split('/').pop()))};
  };
  const manager=new ModSync(path.join(root,'participant'),{request,report:async()=>({data:{ok:true}}),isRunning:closed});
  const instance=path.join(root,'game');await fs.ensureDir(instance);
  const link=`https://host.example/?join=${channel.id}#token=${channel.token}`;
  assert.equal(parseInvite(link).origin,'https://host.example');
  await manager.join(link,instance,'curseforge');
  assert.equal(manager.list()[0].status,'pending');
  assert.equal(await fs.pathExists(path.join(instance,'mods','creator.jar')),false);
  await manager.sync(manager.list()[0].key);
  assert.equal(manager.list()[0].status,'updated');
  assert.equal(manager.list()[0].token,undefined);
  const key=manager.list()[0].key;
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),'2');
  await publisher.publish(channel);await manager.sync(key);
  assert.equal(await fs.readFile(path.join(instance,'mods','creator.jar'),'utf8'),'2');
  await manager.update(key,false);assert.equal(manager.list()[0].enabled,false);
  await manager.leave(key);assert.equal(manager.list().length,0);
  assert.equal(await fs.pathExists(path.join(instance,'mods','creator.jar')),true);
});

test('interrupted install journal is recovered before the next update', async t => {
  const { publisher,channel,mods } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'a.jar'),'old');
  const manifest=await publisher.publish(channel);
  await installManifest(mods,manifest,f=>download(publisher,channel,f),closed);
  const backup='b'.repeat(32), dir=path.join(mods,'.mc-devkit-backups',backup);
  await fs.ensureDir(dir);await fs.copyFile(path.join(mods,'a.jar'),path.join(dir,'a.jar'));
  await fs.writeJson(path.join(mods,'.mc-devkit-transaction.json'),{backup,before:manifest,files:[{name:'a.jar',existed:true},{name:'new.jar',existed:false}]});
  await fs.writeFile(path.join(mods,'a.jar'),'partial');await fs.writeFile(path.join(mods,'new.jar'),'partial');
  await installManifest(mods,manifest,f=>download(publisher,channel,f),closed);
  assert.equal(await fs.readFile(path.join(mods,'a.jar'),'utf8'),'old');
  assert.equal(await fs.pathExists(path.join(mods,'new.jar')),false);
});

test('concurrent channel requests agree and file rules exclude server-only mods', async t => {
  const { publisher, config, channel } = await fixture(t);
  const channels = await Promise.all(Array.from({length:8},()=>publisher.channel({...config,serverFolder:'concurrent'})));
  assert.equal(new Set(channels.map(ch=>ch.id)).size,1);
  for (const name of ['creator-v1.jar','fabric-api-1.jar','server-only.jar']) await fs.writeFile(path.join(channel.sourceDir,name),'a');
  const filtered = await publisher.configure(channel,{patterns:['creator-*.jar','fabric-api-*.jar'],autoPublish:false});
  const manifest=await publisher.publish(filtered);
  assert.deepEqual(manifest.files.map(f=>f.name),['creator-v1.jar','fabric-api-1.jar']);
  await assert.rejects(publisher.configure(filtered,{patterns:['../*.jar']}),/파일 규칙/);
  await assert.rejects(publisher.configure(filtered,{loader:'forge'}),/로더는 변경/);
});

test('automatic source watching publishes replacements without another publish click', async t => {
  const { publisher, channel } = await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),'first');
  const watched=await publisher.configure(channel,{autoPublish:true});
  const watcher=publisher.watchers.get(channel.id);
  await new Promise(resolve=>watcher.once('ready',resolve));
  const first=await publisher.publish(watched);
  const changed=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('watch publish timed out')),12000);
    publisher.onChange=manifest=>{if(manifest.revision!==first.revision){clearTimeout(timer);resolve(manifest);}};
  });
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),'second');
  const next=await changed;
  assert.equal(next.files[0].sha256,sha256('second'));
});

test('startup publishes edits made while the host was offline', async t => {
  const { root,publisher,channel }=await fixture(t);
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),'before');
  await publisher.publish(channel);
  await publisher.save({...channel,autoPublish:true});
  await publisher.close();
  await fs.writeFile(path.join(channel.sourceDir,'creator.jar'),'offline edit');
  const restored=new PackPublisher(path.join(root,'host'));t.after(()=>restored.close());
  await restored.init();
  assert.equal((await restored.manifest(channel.id)).files[0].sha256,sha256('offline edit'));
});
