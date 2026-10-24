'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { zip } = require('./jar-fixture');
const { launchMinecraft, loadVersion, allowed, tokenize } = require('../core/minecraft-client');

const session = { name: 'LinkedPlayer', uuid: '12345678123412341234123456789abc', accessToken: 'PRIVATE_MINECRAFT_ACCESS_TOKEN', userType: 'msa' };
async function fixture(t, { loader = 'fabric', legacy = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'devkit-client-'));
  t.after(() => fs.remove(temp));
  const root = path.join(temp, 'appdata', '.minecraft');
  const gameDir = path.join(temp, 'isolated game');
  await fs.ensureDir(path.join(gameDir, 'mods'));
  const base = { id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', type: 'release',
    javaVersion: { majorVersion: 17 }, assetIndex: { id: '5' }, downloads: { client: {} },
    libraries: [{ name: 'com.example:common:1' }],
    arguments: { jvm: ['-Djava.library.path=${natives_directory}', '-Dminecraft.launcher.brand=${launcher_name}', '-cp', '${classpath}',
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-Dos.rule=windows' },
      { rules: [{ action: 'allow', os: { name: 'linux' } }], value: '-Dos.rule=linux' }],
    game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}',
      '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}',
      { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' }] } };
  const id = loader === 'fabric' ? 'fabric-loader-0.16.9-1.20.1' : loader === 'forge' ? '1.20.1-forge-47.3.0' : loader === 'neoforge' ? '1.20.1-neoforge-47.1.106' : base.id;
  const loaderName = { fabric: 'net.fabricmc:fabric-loader:0.16.9', forge: 'net.minecraftforge:forge:1.20.1-47.3.0:client', neoforge: 'net.neoforged:neoforge:47.1.106' }[loader];
  const child = { id, inheritsFrom: base.id, mainClass: loader === 'fabric' ? 'net.fabricmc.loader.impl.launch.knot.KnotClient' : 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [{ name: 'com.example:common:2' }, { name: loaderName }],
    arguments: { jvm: ['-Dloader.enabled=true'], game: ['--loader-test', 'installed'] } };
  if (legacy) {
    delete base.arguments;
    base.minecraftArguments = '--username ${auth_player_name} --version ${version_name} --gameDir "${game_directory}" --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType msa --legacy "quoted value"';
    delete child.arguments;
  }
  const versionFile = version => path.join(root, 'versions', version.id, `${version.id}.json`);
  await fs.outputJson(versionFile(base), base);
  await fs.outputFile(path.join(root, 'versions', base.id, `${base.id}.jar`), 'client jar');
  if (loaderName) await fs.outputJson(versionFile(child), child);
  const libFile = name => { const [group, artifact, version, classifier] = name.split(':'); return path.join(root, 'libraries', ...group.split('.'), artifact, version, `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`); };
  for (const library of [...base.libraries, ...(loaderName ? child.libraries : [])]) await fs.outputFile(libFile(library.name), 'library');
  await fs.outputJson(path.join(root, 'assets', 'indexes', '5.json'), { objects: { 'minecraft/sounds/test.ogg': { hash: 'a'.repeat(40), size: 5 } } });
  await fs.outputFile(path.join(root, 'assets', 'objects', 'aa', 'a'.repeat(40)), 'asset');
  const profiles = { profiles: { linked: { name: 'Linked profile', gameDir, lastVersionId: id }, unrelated: { gameDir: path.join(temp, 'wrong profile'), lastVersionId: id } } };
  await fs.outputJson(path.join(root, 'launcher_profiles.json'), profiles);
  const sub = { modsDir: path.join(gameDir, 'mods'), launcher: 'official', minecraft: '1.20.1', loader,
    loaderVersion: { fabric: '0.16.9', forge: '47.3.0', neoforge: '47.1.106', none: '' }[loader], environment: { versionRoot: root, versionId: id, profileId: 'linked' } };
  const calls = [];
  const processes = [];
  const spawn = (java, args, options) => {
    calls.push({ java, args, options });
    const childProcess = new EventEmitter(); childProcess.pid = 4567; childProcess.unref = () => {};
    processes.push(childProcess);
    queueMicrotask(() => childProcess.emit('spawn'));
    return childProcess;
  };
  const options = { home: path.join(temp, 'home'), appData: path.join(temp, 'appdata'), env: {}, platform: 'win32', arch: 'x64',
    probeJava: async () => ({ major: 17, arch: 'x64' }), spawn };
  return { temp, root, gameDir, base, child, id, sub, options, calls, processes, versionFile, libFile, profiles };
}
function valueOf(args, flag) { return args[args.indexOf(flag) + 1]; }

test('installed Fabric profile inherits libraries and launches with linked identity in its own folder', async t => {
  const f = await fixture(t);
  const version = await loadVersion(f.root, f.id);
  assert.deepEqual(version.libraries.map(l => l.name), ['com.example:common:2', 'net.fabricmc:fabric-loader:0.16.9']);
  const result = await launchMinecraft(f.sub, session, f.options);
  assert.deepEqual(result, { launched: true, pid: 4567, message: 'LinkedPlayer 계정으로 연결한 마인크래프트 프로필을 시작했습니다.' });
  assert.equal(f.calls.length, 1);
  const { args, options } = f.calls[0];
  assert.ok(args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'));
  assert.equal(valueOf(args, '--accessToken'), session.accessToken);
  assert.equal(valueOf(args, '--uuid'), session.uuid);
  assert.equal(valueOf(args, '--username'), session.name);
  assert.equal(valueOf(args, '--gameDir'), f.gameDir);
  assert.equal(valueOf(args, '--version'), f.id);
  assert.ok(valueOf(args, '-cp').includes(f.libFile('com.example:common:2')));
  assert.ok(!valueOf(args, '-cp').includes(f.libFile('com.example:common:1')));
  assert.ok(valueOf(args, '-cp').includes(path.join(f.root, 'versions', '1.20.1', '1.20.1.jar')));
  assert.ok(args.includes('-Dloader.enabled=true'));
  assert.ok(args.includes('-Dos.rule=windows'));
  assert.ok(!args.includes('-Dos.rule=linux'));
  assert.ok(!args.includes('--demo'));
  assert.deepEqual(options, { cwd: f.gameDir, shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
  assert.ok(!JSON.stringify(result).includes(session.accessToken));
  assert.equal(await fs.readFile(path.join(f.root, 'launcher_profiles.json'), 'utf8').then(text => text.includes(session.accessToken)), false);
});

test('Vanilla, Forge and NeoForge use the exact installed launch manifest', async t => {
  for (const loader of ['none', 'forge', 'neoforge']) {
    const f = await fixture(t, { loader });
    await launchMinecraft(f.sub, session, f.options);
    assert.equal(valueOf(f.calls[0].args, '--version'), f.id);
    assert.ok(f.calls[0].args.includes(loader === 'none' ? 'net.minecraft.client.main.Main' : 'cpw.mods.bootstraplauncher.BootstrapLauncher'));
  }
});

test('a changed official profile or another gameDir never launches', async t => {
  const f = await fixture(t);
  f.profiles.profiles.linked.gameDir = path.join(f.temp, 'wrong profile');
  await fs.outputJson(path.join(f.root, 'launcher_profiles.json'), f.profiles);
  await assert.rejects(launchMinecraft(f.sub, session, f.options), /프로필|버전/);
  assert.equal(f.calls.length, 0);
  f.profiles.profiles.linked.gameDir = f.gameDir;
  f.profiles.profiles.linked.lastVersionId = '1.20.1';
  await fs.outputJson(path.join(f.root, 'launcher_profiles.json'), f.profiles);
  await assert.rejects(launchMinecraft(f.sub, session, f.options), /프로필|버전/);
  assert.equal(f.calls.length, 0);
});

test('environment mismatches, missing inherited metadata, libraries, client jars and assets block spawning', async t => {
  for (const problem of ['environment', 'metadata', 'library', 'jar', 'asset']) {
    const f = await fixture(t);
    if (problem === 'environment') f.sub.loaderVersion = '0.16.8';
    if (problem === 'metadata') await fs.remove(f.versionFile(f.base));
    if (problem === 'library') await fs.remove(f.libFile('com.example:common:2'));
    if (problem === 'jar') await fs.remove(path.join(f.root, 'versions', '1.20.1', '1.20.1.jar'));
    if (problem === 'asset') await fs.remove(path.join(f.root, 'assets', 'objects', 'aa', 'a'.repeat(40)));
    await assert.rejects(launchMinecraft(f.sub, session, f.options), /설치|버전|프로필/);
    assert.equal(f.calls.length, 0, problem);
  }
});

test('missing or incompatible Java never silently starts with a different runtime', async t => {
  const f = await fixture(t);
  for (const result of [null, { major: 21, arch: 'x64' }, { major: 17, arch: 'arm64' }]) {
    await assert.rejects(launchMinecraft(f.sub, session, { ...f.options, probeJava: async () => result }), /Java 17 \(x64\)/);
  }
  assert.equal(f.calls.length, 0);
});

test('an explicitly selected Javaw installation is verified through its console Java executable', async t => {
  const f = await fixture(t);
  const bin = path.join(f.temp, 'custom-java', 'bin');
  await fs.outputFile(path.join(bin, 'java.exe'), 'installed executable fixture');
  f.profiles.profiles.linked.javaDir = path.join(bin, 'javaw.exe');
  await fs.outputJson(path.join(f.root, 'launcher_profiles.json'), f.profiles);
  await launchMinecraft(f.sub, session, { ...f.options, probeJava: async file => file === path.join(bin, 'java.exe') ? { major: 17, arch: 'amd64' } : null });
  assert.equal(f.calls[0].java, path.join(bin, 'java.exe'));
});

test('legacy Minecraft arguments keep quoted values and never use shell tokenization', async t => {
  const f = await fixture(t, { legacy: true });
  await launchMinecraft(f.sub, session, f.options);
  assert.equal(valueOf(f.calls[0].args, '--legacy'), 'quoted value');
  assert.equal(valueOf(f.calls[0].args, '--gameDir'), f.gameDir);
  assert.deepEqual(tokenize('--name "a b" --literal "$(unsafe)" --empty ""'), ['--name', 'a b', '--literal', '$(unsafe)', '--empty', '']);
  assert.throws(() => tokenize('--name "unfinished'), /지원하지/);
});

test('rules follow platform, version, architecture, features and last matching action', () => {
  const context = { platform: 'win32', arch: 'x64', osVersion: '10.0.19045', features: {} };
  assert.equal(allowed(undefined, context), true);
  assert.equal(allowed([{ action: 'allow', os: { name: 'linux' } }], context), false);
  assert.equal(allowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows', version: '^10\\.', arch: 'x86_64' } }], context), false);
  assert.equal(allowed([{ action: 'allow', features: { is_demo_user: true } }], context), false);
  assert.equal(allowed([{ action: 'allow', features: { is_demo_user: false } }], context), true);
});

test('native archives are extracted into a unique directory for each launch, then cleaned on exit', async t => {
  const f = await fixture(t);
  const native = path.join(f.root, 'libraries', 'native', 'native.jar');
  await fs.outputFile(native, zip({ 'META-INF/test': 'ignore', 'lwjgl.dll': 'native bytes', 'LICENSE': 'ignore' }));
  f.child.libraries.push({ name: 'com.example:native:1', natives: { windows: 'natives-windows' }, downloads: { classifiers: { 'natives-windows': { path: 'native/native.jar' } } } });
  await fs.outputJson(f.versionFile(f.child), f.child);
  await launchMinecraft(f.sub, session, f.options);
  await launchMinecraft(f.sub, session, f.options);
  const dirs = f.calls.map(call => call.args.find(arg => arg.startsWith('-Djava.library.path=')).split('=').slice(1).join('='));
  assert.notEqual(dirs[0], dirs[1]);
  for (const dir of dirs) {
    assert.ok(dir.startsWith(path.join(f.gameDir, '.mc-devkit', 'natives')));
    assert.equal(await fs.readFile(path.join(dir, 'lwjgl.dll'), 'utf8'), 'native bytes');
    assert.equal(await fs.pathExists(path.join(dir, 'LICENSE')), false);
  }
  f.processes[0].emit('exit', 0);
  for (let i = 0; i < 20 && await fs.pathExists(dirs[0]); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await fs.pathExists(dirs[0]), false);
  assert.equal(await fs.pathExists(dirs[1]), true);
});

test('path traversal in native ZIPs, library paths or inheritance is rejected', async t => {
  for (const problem of ['native', 'library', 'inheritance']) {
    const f = await fixture(t);
    if (problem === 'native') {
      await fs.outputFile(path.join(f.root, 'libraries', 'bad.jar'), zip({ '../outside.dll': 'bad' }));
      f.child.libraries.push({ name: 'com.example:bad:1', natives: { windows: 'natives-windows' }, downloads: { classifiers: { 'natives-windows': { path: 'bad.jar' } } } });
    }
    if (problem === 'library') f.child.libraries.push({ name: 'com.example:bad:1', downloads: { artifact: { path: '../outside.jar' } } });
    if (problem === 'inheritance') f.base.inheritsFrom = f.id;
    await fs.outputJson(f.versionFile(f.base), f.base);
    await fs.outputJson(f.versionFile(f.child), f.child);
    await assert.rejects(launchMinecraft(f.sub, session, f.options), /안전|지원|버전/);
    assert.equal(f.calls.length, 0);
    assert.equal(await fs.pathExists(path.join(f.gameDir, '.mc-devkit', 'outside.dll')), false);
  }
});

test('CurseForge uses only matching installed metadata and keeps the selected instance directory', async t => {
  const f = await fixture(t);
  await fs.outputJson(path.join(f.gameDir, 'minecraftinstance.json'), { name: 'CF instance', gameVersion: '1.20.1', baseModLoader: { name: 'fabric-0.16.9' } });
  f.sub.launcher = 'curseforge'; f.sub.environment = null;
  await launchMinecraft(f.sub, session, f.options);
  assert.equal(valueOf(f.calls[0].args, '--gameDir'), f.gameDir);
  assert.equal(valueOf(f.calls[0].args, '--version'), f.id);
  const other = { ...f.child, id: 'another-fabric-loader-0.16.9-1.20.1' };
  await fs.outputJson(f.versionFile(other), other);
  await assert.rejects(launchMinecraft(f.sub, session, f.options), /여러 개/);
  assert.equal(f.calls.length, 1);
});

test('Modrinth instance metadata can reuse an exact installed runtime without switching instance folders', async t => {
  const f = await fixture(t);
  await fs.outputJson(path.join(f.gameDir, 'profile.json'), { metadata: { name: 'Modrinth instance', game_version: '1.20.1', loader: 'fabric', loader_version: '0.16.9' } });
  f.sub.launcher = 'modrinth'; f.sub.environment = null;
  await launchMinecraft(f.sub, session, f.options);
  assert.equal(valueOf(f.calls[0].args, '--gameDir'), f.gameDir);
  assert.equal(valueOf(f.calls[0].args, '--version'), f.id);
  await fs.remove(path.join(f.root, 'versions'));
  await assert.rejects(launchMinecraft(f.sub, session, f.options), /설치/);
  assert.equal(f.calls.length, 1);
});

test('missing account or spawn failures never expose tokens, raw exceptions or command lines', async t => {
  const f = await fixture(t);
  await assert.rejects(launchMinecraft(f.sub, null, f.options), /계정/);
  await assert.rejects(launchMinecraft(f.sub, { ...session, userType: 'offline' }, f.options), /계정/);
  for (const synchronous of [true, false]) {
    const spawn = () => {
      const error = Object.assign(new Error(`spawn java --accessToken ${session.accessToken}`), { spawnargs: [session.accessToken] });
      if (synchronous) throw error;
      const child = new EventEmitter(); queueMicrotask(() => child.emit('error', error)); return child;
    };
    await assert.rejects(launchMinecraft(f.sub, session, { ...f.options, spawn }), error => {
      assert.ok(!error.message.includes(session.accessToken)); assert.ok(!error.message.includes('--accessToken'));
      assert.match(error.message, /시작하지 못/); return true;
    });
  }
  assert.equal(f.calls.length, 0);
});
