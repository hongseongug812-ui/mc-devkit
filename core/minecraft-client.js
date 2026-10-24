'use strict';

// Installed-profile launching only. Authentication tokens are passed directly to
// Java, never written to a launcher profile, an argument file, or a diagnostic log.
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn: defaultSpawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');
const { safeDirectory, regularFile } = require('./pack-utils');
const { detectInstance, assertEnvironment, versionInfo } = require('./launcher-profiles');
const { requiredJava } = require('./versions');

class LaunchError extends Error {}
const fail = message => { throw new LaunchError(message); };
const missing = '게임 실행 파일이 완전히 설치되지 않았습니다. 연결한 런처에서 이 프로필을 한 번 실행한 뒤 다시 시도하세요.';
const unsupported = '이 프로필의 실행 형식을 지원하지 않습니다. 공식 런처에 같은 마인크래프트·로더 버전을 설치하고 해당 게임 폴더를 다시 연결하세요.';
const osName = platform => ({ win32: 'windows', darwin: 'osx', linux: 'linux' })[platform];
const idOkay = id => typeof id === 'string' && id.length <= 160 && /^[A-Za-z0-9._+\-]+$/.test(id) && !['.', '..'].includes(id);
const samePath = (a, b, platform) => platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0')) fail(unsupported);
  if (relative.split('/').some(p => !p || p === '.' || p === '..')) fail(unsupported);
  const result = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(path.resolve(root), result);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) fail(unsupported);
  return result;
}
async function readJson(file, max = 8 * 1024 * 1024) {
  await safeDirectory(path.dirname(file));
  if ((await regularFile(file)).size > max) fail(unsupported);
  return fs.readJson(file);
}
async function optionalJson(file) {
  try { return await readJson(file); } catch { return null; }
}
async function installedFile(file) {
  try { await safeDirectory(path.dirname(file)); await regularFile(file); return file; }
  catch { fail(missing); }
}

function libraryKey(library) {
  const parts = String(library.name || '').split(':');
  return [parts[0], parts[1], parts[3] || '', String(library.name || '').split('@')[1] || 'jar'].join(':');
}
function mergeVersion(parent, child) {
  const libraries = new Map((parent.libraries || []).map(l => [libraryKey(l), l]));
  for (const library of child.libraries || []) libraries.set(libraryKey(library), library);
  return { ...parent, ...child, libraries: [...libraries.values()],
    arguments: { game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])] },
    // An inherited jar belongs to the parent unless the child installed its own.
    _jarId: child.jar || (child.downloads?.client ? child.id : parent._jarId) || child.id };
}
async function loadVersion(root, id, seen = new Set()) {
  if (!idOkay(id) || seen.has(id) || seen.size >= 12) fail(unsupported);
  seen.add(id);
  let own;
  try { own = await readJson(path.join(root, 'versions', id, `${id}.json`)); }
  catch (error) { if (error instanceof LaunchError) throw error; fail(missing); }
  if (!own || (own.id && own.id !== id) || !Array.isArray(own.libraries || []) || (own.arguments && (!Array.isArray(own.arguments.game || []) || !Array.isArray(own.arguments.jvm || [])))) fail(unsupported);
  const parent = own.inheritsFrom ? await loadVersion(root, own.inheritsFrom, seen) : {};
  return mergeVersion(parent, { ...own, id });
}

function allowed(rules, context) {
  if (!rules) return true;
  if (!Array.isArray(rules)) fail(unsupported);
  let result = false;
  for (const rule of rules) {
    if (!rule || !['allow', 'disallow'].includes(rule.action)) fail(unsupported);
    if (rule.os?.name && rule.os.name !== osName(context.platform)) continue;
    try {
      if (rule.os?.version && !new RegExp(rule.os.version).test(context.osVersion)) continue;
      if (rule.os?.arch && ![context.arch, context.arch === 'x64' ? 'x86_64' : context.arch === 'ia32' ? 'x86' : context.arch === 'arm64' ? 'aarch64' : context.arch]
        .some(arch => new RegExp(`^(?:${rule.os.arch})$`).test(arch))) continue;
    } catch { fail(unsupported); }
    if (rule.features && Object.entries(rule.features).some(([key, value]) => (context.features[key] ?? false) !== value)) continue;
    result = rule.action === 'allow';
  }
  return result;
}
function argumentList(list, context) {
  const result = [];
  for (const item of list || []) {
    if (typeof item === 'string') result.push(item);
    else if (item && allowed(item.rules, context)) {
      const values = Array.isArray(item.value) ? item.value : [item.value];
      if (!values.every(v => typeof v === 'string')) fail(unsupported);
      result.push(...values);
    }
  }
  return result;
}
function tokenize(value) {
  if (typeof value !== 'string' || value.length > 100000) fail(unsupported);
  const result = [];
  let token = '', quote = '', started = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '\\' && ['"', "'", '\\'].includes(value[i + 1])) { token += value[++i]; started = true; }
    else if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { result.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) fail(unsupported);
  if (started) result.push(token);
  return result;
}
function substitute(value, variables) {
  const result = value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) fail(unsupported);
    return String(variables[key]);
  });
  if (result.includes('\0')) fail(unsupported);
  return result;
}
function mavenPath(name) {
  if (typeof name !== 'string') fail(unsupported);
  const [coordinate, extension = 'jar'] = name.split('@');
  const [group, artifact, version, classifier, extra] = coordinate.split(':');
  if (extra || !group || ![...group.split('.'), artifact, version, classifier || 'jar', extension].every(idOkay)) fail(unsupported);
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
}

async function resolveProfile(sub, options) {
  if (!sub || typeof sub.modsDir !== 'string' || path.basename(sub.modsDir).toLowerCase() !== 'mods') fail('연결한 게임 폴더를 다시 선택하세요.');
  const gameDir = await safeDirectory(path.dirname(sub.modsDir));
  const hint = sub.environment || {};
  let actual;
  try {
    actual = await detectInstance(gameDir, sub.launcher, hint);
    assertEnvironment(actual, sub);
  } catch { fail('모드팩과 연결한 프로필의 게임·로더 버전이 일치하지 않습니다. 정확한 프로필을 다시 선택하세요.'); }
  const official = path.join(options.appData, '.minecraft');
  if (sub.launcher === 'official') {
    if (!hint.profileId || !hint.versionRoot || !idOkay(hint.versionId)) fail('실행할 공식 런처 프로필을 목록에서 다시 선택하세요.');
    const root = await safeDirectory(hint.versionRoot);
    const profiles = await optionalJson(path.join(root, 'launcher_profiles.json')) || await optionalJson(path.join(root, 'launcher_profiles_microsoft_store.json'));
    const profile = profiles?.profiles?.[hint.profileId];
    if (!profile || profile.lastVersionId !== hint.versionId || !samePath(profile.gameDir || root, gameDir, options.platform)) fail('연결한 런처 프로필이 변경되었습니다. 게임 프로필을 다시 선택하세요.');
    return { root, id: profile.lastVersionId, gameDir, javaPath: profile.javaDir };
  }
  if (!['curseforge', 'modrinth'].includes(sub.launcher)) fail(unsupported);
  // These roots contain installed Mojang-format version manifests. Never pick a
  // different launcher's user profile or its gameDir just because its name fits.
  const roots = [hint.versionRoot,
    ...(sub.launcher === 'curseforge' ? [path.join(path.dirname(path.dirname(gameDir)), 'Install'), path.join(options.home, 'curseforge', 'minecraft', 'Install')]
      : [path.join(options.appData, 'com.modrinth.theseus', 'meta'), path.join(path.dirname(path.dirname(gameDir)), 'meta')]), official].filter(Boolean);
  const matches = [];
  const unique = new Set();
  for (const candidate of roots) {
    const root = path.resolve(candidate);
    if (unique.has(root.toLowerCase())) continue;
    unique.add(root.toLowerCase());
    try { await safeDirectory(root); } catch { continue; }
    const ids = hint.versionId && hint.versionRoot && samePath(root, hint.versionRoot, options.platform)
      ? [hint.versionId] : (await fs.readdir(path.join(root, 'versions')).catch(() => [])).slice(0, 500);
    for (const id of ids) {
      if (!idOkay(id)) continue;
      const info = await versionInfo(root, id);
      try { assertEnvironment(info, { ...sub, loaderVersion: sub.loaderVersion || actual.loaderVersion }); }
      catch { continue; }
      if (await fs.pathExists(path.join(root, 'versions', id, `${id}.json`))) matches.push({ root, id, gameDir });
    }
    // Prefer the instance's own installation; do not switch roots if incomplete.
    if (matches.length) break;
  }
  if (matches.length !== 1) fail(matches.length ? '같은 버전의 실행 환경이 여러 개입니다. 공식 런처의 정확한 프로필을 선택해 다시 연결하세요.' : missing);
  return matches[0];
}

async function librariesFor(root, metadata, context) {
  const jars = [], natives = [];
  for (const library of metadata.libraries) {
    if (library.clientreq === false || !allowed(library.rules, context)) continue;
    const nativeClassifier = library.natives?.[osName(context.platform)]?.replace(/\$\{arch\}/g, context.arch === 'ia32' ? '32' : '64');
    if (library.downloads?.artifact || !library.natives) {
      const relative = library.downloads?.artifact?.path || mavenPath(library.name);
      jars.push(await installedFile(inside(path.join(root, 'libraries'), relative)));
    }
    if (nativeClassifier) {
      const artifact = library.downloads?.classifiers?.[nativeClassifier];
      const relative = artifact?.path || mavenPath(`${library.name.split(':').slice(0, 3).join(':')}:${nativeClassifier}`);
      natives.push({ file: await installedFile(inside(path.join(root, 'libraries'), relative)), exclude: library.extract?.exclude || [] });
    }
  }
  return { jars, natives };
}

async function extractNatives(archives, target) {
  let count = 0, total = 0;
  for (const archive of archives) await new Promise((resolve, reject) => {
    yauzl.open(archive.file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new LaunchError(missing));
      let finished = false;
      const abort = () => { if (finished) return; finished = true; zip.close(); reject(new LaunchError('네이티브 라이브러리 압축을 안전하게 해제할 수 없습니다. 런처에서 게임을 다시 설치하세요.')); };
      zip.on('error', abort);
      zip.on('end', () => { if (!finished) { finished = true; resolve(); } });
      zip.on('entry', entry => {
        (async () => {
          count += 1; total += entry.uncompressedSize;
          if (count > 10000 || total > 512 * 1024 * 1024 || entry.uncompressedSize > 128 * 1024 * 1024 || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error();
          const name = entry.fileName;
          if (name.endsWith('/') || name.startsWith('META-INF/') || archive.exclude.some(prefix => name.startsWith(prefix))) return zip.readEntry();
          const output = inside(target, name);
          if (!/\.(dll|dylib|jnilib|so(?:\.\d+)*)$/i.test(name)) return zip.readEntry();
          await safeDirectory(path.dirname(output), true);
          if (await fs.pathExists(output)) await regularFile(output);
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (err, value) => err ? rej(err) : res(value)));
          await pipeline(stream, fs.createWriteStream(output));
          zip.readEntry();
        })().catch(abort);
      });
      zip.readEntry();
    });
  });
}

async function assetsFor(root, metadata, gameDir) {
  const assets = path.join(root, 'assets'), id = metadata.assetIndex?.id || metadata.assets;
  if (!idOkay(id)) fail(unsupported);
  let index;
  try { index = await readJson(path.join(assets, 'indexes', `${id}.json`), 32 * 1024 * 1024); }
  catch { fail(missing); }
  const entries = Object.values(index.objects || {});
  if (entries.length > 100000) fail(unsupported);
  for (let offset = 0; offset < entries.length; offset += 32) {
    await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
      if (!/^[a-f0-9]{40}$/.test(entry.hash)) fail(unsupported);
      await installedFile(path.join(assets, 'objects', entry.hash.slice(0, 2), entry.hash));
    }));
  }
  let gameAssets = assets;
  if (index.virtual) gameAssets = await safeDirectory(path.join(assets, 'virtual', id)).catch(() => fail(missing));
  if (index.map_to_resources) await safeDirectory(path.join(gameDir, 'resources')).catch(() => fail(missing));
  return { assets, id, gameAssets };
}

function javaArch(value) {
  return ({ amd64: 'x64', x86_64: 'x64', aarch64: 'arm64', x86: 'ia32', i386: 'ia32', i686: 'ia32' })[value] || value;
}
async function probeJava(file) {
  return new Promise(resolve => {
    execFile(file, ['-XshowSettings:properties', '-version'], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      const output = `${stdout}\n${stderr}`;
      const version = output.match(/(?:java\.version\s*=\s*|version\s+")(\d+)(?:\.(\d+))?/);
      const arch = output.match(/os\.arch\s*=\s*([^\s]+)/)?.[1];
      resolve(version ? { major: Number(version[1]) === 1 ? Number(version[2]) : Number(version[1]), arch: javaArch(arch) } : null);
    });
  });
}
async function findJava(profile, metadata, options) {
  const major = Number(metadata.javaVersion?.majorVersion || requiredJava(options.minecraft));
  if (!Number.isInteger(major) || major < 8 || major > 100) fail(unsupported);
  const exe = options.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [profile.javaPath && /javaw\.exe$/i.test(profile.javaPath) ? profile.javaPath.replace(/javaw\.exe$/i, 'java.exe') : profile.javaPath,
    options.env.JAVA_HOME && path.join(options.env.JAVA_HOME, 'bin', exe),
    options.env.DEVKIT_RESOURCES && path.join(options.env.DEVKIT_RESOURCES, 'jre', 'bin', exe),
    path.join(options.home, '.mc-devkit', 'jre', String(major), ...(options.platform === 'darwin' ? ['Contents', 'Home'] : []), 'bin', exe)].filter(Boolean);
  const roots = [path.join(profile.root, 'runtime'), path.join(options.appData, '.minecraft', 'runtime'),
    path.join(options.appData, 'com.modrinth.theseus', 'meta', 'java_versions'),
    ...(options.platform === 'darwin' ? ['/Library/Java/JavaVirtualMachines', path.join(options.home, 'Library', 'Java', 'JavaVirtualMachines')]
      : options.platform === 'linux' ? ['/usr/lib/jvm', '/usr/java'] : []),
    ...[options.env.ProgramFiles, options.env['ProgramFiles(x86)']].filter(Boolean).flatMap(root => ['Java', 'Eclipse Adoptium', 'Microsoft'].map(name => path.join(root, name)))];
  const visited = new Set();
  const walk = async (dir, depth) => {
    if (depth > 6 || visited.size > 1000 || visited.has(dir)) return;
    visited.add(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === exe && path.basename(dir) === 'bin') candidates.push(path.join(dir, entry.name));
      else if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  candidates.push('java');
  const unique = new Set();
  for (const candidate of candidates) {
    if (unique.has(candidate)) continue;
    unique.add(candidate);
    if (candidate !== 'java') { try { await installedFile(candidate); } catch { continue; } }
    let result;
    try { result = await options.probeJava(candidate); } catch { continue; }
    if (result?.major === major && javaArch(result.arch) === options.arch) return candidate;
  }
  fail(`이 프로필에는 Java ${major} (${options.arch})가 필요합니다. 연결한 런처에서 해당 프로필을 한 번 실행하거나 호환 Java를 설치하세요.`);
}

function authenticated(session) {
  if (!session || session.userType !== 'msa' || !/^[A-Za-z0-9_]{1,16}$/.test(session.name || '') || !/^[a-fA-F0-9]{32}$/.test(String(session.uuid || '').replace(/-/g, '')) || typeof session.accessToken !== 'string' || !session.accessToken || session.accessToken.length > 32768 || /[\x00-\x20]/.test(session.accessToken)) fail('정품 마인크래프트 계정을 먼저 연결하세요. 로그인 상태를 새로 확인한 뒤 실행하세요.');
  return { ...session, uuid: session.uuid.replace(/-/g, '') };
}
function replaceFlag(args, flag, value, append = true) {
  const output = [];
  let found = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) { i += 1; found = true; }
    else if (args[i].startsWith(`${flag}=`)) found = true;
    else output.push(args[i]);
  }
  if (found || append) output.push(flag, value);
  return output;
}
function buildArguments(metadata, context, variables, session, memoryMB) {
  if (typeof metadata.mainClass !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(metadata.mainClass)) fail(unsupported);
  let jvm = argumentList(metadata.arguments.jvm, context).map(arg => substitute(arg, variables));
  if (!jvm.length) jvm = [`-Djava.library.path=${variables.natives_directory}`, '-cp', variables.classpath];
  for (let i = 0; i < jvm.length; i += 1) {
    if (['-cp', '-classpath', '--class-path'].includes(jvm[i])) jvm[++i] = variables.classpath;
    else if (jvm[i].startsWith('--class-path=')) jvm[i] = `--class-path=${variables.classpath}`;
  }
  if (!jvm.some(arg => ['-cp', '-classpath', '--class-path'].includes(arg) || arg.startsWith('--class-path='))) jvm.push('-cp', variables.classpath);
  jvm = jvm.filter(arg => !/^-Xm[sx]/.test(arg));
  jvm.unshift(`-Xmx${memoryMB}M`);
  let game = metadata.minecraftArguments ? tokenize(metadata.minecraftArguments) : argumentList(metadata.arguments.game, context);
  game = game.map(arg => substitute(arg, variables));
  if (!game.includes('--accessToken') && !game.some(arg => arg.startsWith('--accessToken=')) && !game.includes('--session')) fail(unsupported);
  for (const [flag, value] of [['--username', session.name], ['--uuid', session.uuid], ['--accessToken', session.accessToken], ['--userType', 'msa'], ['--gameDir', variables.game_directory]]) game = replaceFlag(game, flag, value);
  game = replaceFlag(game, '--session', variables.auth_session, false);
  game = replaceFlag(game, '--version', variables.version_name, false);
  return [...jvm, metadata.mainClass, ...game];
}

async function launchMinecraft(sub, session, input = {}) {
  let nativesDir;
  try {
    session = authenticated(session);
    const home = input.home || os.homedir();
    const options = { appData: input.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), home,
      env: input.env || process.env, platform: input.platform || process.platform, arch: input.arch || process.arch,
      osVersion: input.osVersion || os.release(), features: {}, probeJava: input.probeJava || probeJava };
    if (!osName(options.platform) || !['x64', 'arm64', 'ia32'].includes(options.arch)) fail(unsupported);
    const profile = await resolveProfile(sub, options);
    const metadata = await loadVersion(profile.root, profile.id);
    // Recheck the resolved manifest itself, including explicitly linked profiles.
    try { assertEnvironment(await versionInfo(profile.root, profile.id), sub); }
    catch { fail('설치된 실행 환경이 모드팩 버전과 일치하지 않습니다. 프로필을 다시 연결하세요.'); }
    const java = await findJava(profile, metadata, { ...options, minecraft: sub.minecraft });
    const { jars, natives } = await librariesFor(profile.root, metadata, options);
    if (!idOkay(metadata._jarId)) fail(unsupported);
    const client = await installedFile(path.join(profile.root, 'versions', metadata._jarId, `${metadata._jarId}.jar`));
    const assets = await assetsFor(profile.root, metadata, profile.gameDir);
    const nativesRoot = await safeDirectory(path.join(profile.gameDir, '.mc-devkit', 'natives'), true);
    nativesDir = await fs.mkdtemp(path.join(nativesRoot, `${crypto.createHash('sha256').update(profile.id).digest('hex').slice(0, 12)}-`));
    await extractNatives(natives, nativesDir);
    const variables = { auth_player_name: session.name, auth_uuid: session.uuid, auth_access_token: session.accessToken,
      auth_session: `token:${session.accessToken}:${session.uuid}`, user_type: 'msa', user_properties: '{}',
      clientid: session.clientId || '', auth_xuid: session.xuid || '', version_name: profile.id,
      version_type: metadata.type || 'release', game_directory: profile.gameDir, assets_root: assets.assets,
      assets_index_name: assets.id, game_assets: assets.gameAssets, natives_directory: nativesDir,
      library_directory: path.join(profile.root, 'libraries'), classpath_separator: options.platform === 'win32' ? ';' : ':',
      classpath: [...new Set([...jars, client])].join(options.platform === 'win32' ? ';' : ':'),
      launcher_name: 'MC-DevKit', launcher_version: require('../package.json').version };
    const memoryMB = Number.isInteger(input.memoryMB) && input.memoryMB >= 512 && input.memoryMB <= 32768 ? input.memoryMB : 2048;
    const args = buildArguments(metadata, options, variables, session, memoryMB);
    if (metadata.logging?.client) {
      const logging = metadata.logging.client;
      if (!idOkay(logging.file?.id) || typeof logging.argument !== 'string') fail(unsupported);
      const logConfig = await installedFile(path.join(assets.assets, 'log_configs', logging.file.id));
      args.unshift(substitute(logging.argument, { ...variables, path: logConfig }));
    }
    return await new Promise((resolve, reject) => {
      let child;
      const onError = () => reject(new LaunchError('게임 프로세스를 시작하지 못했습니다. Java 설치와 게임 폴더 접근 권한을 확인하세요.'));
      try { child = (input.spawn || defaultSpawn)(java, args, { cwd: profile.gameDir, shell: false, windowsHide: true, detached: true, stdio: 'ignore' }); }
      catch { onError(); return; }
      child.once('error', onError);
      child.once('exit', () => { fs.remove(nativesDir).catch(() => {}); });
      child.once('spawn', () => {
        child.unref?.();
        resolve({ launched: true, pid: child.pid || null, message: `${session.name} 계정으로 연결한 마인크래프트 프로필을 시작했습니다.` });
      });
    });
  } catch (error) {
    if (nativesDir) await fs.remove(nativesDir).catch(() => {});
    // child_process exceptions can contain spawnargs, including access tokens.
    if (error instanceof LaunchError) throw new Error(error.message);
    throw new Error('설치된 게임 실행 환경을 확인하지 못했습니다. 런처에서 연결한 프로필을 한 번 실행한 뒤 다시 시도하세요.');
  }
}

module.exports = { launchMinecraft, loadVersion, allowed, tokenize, buildArguments };
