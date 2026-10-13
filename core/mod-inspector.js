'use strict';

const yauzl = require('yauzl');
const toml = require('@iarna/toml');
const semver = require('semver');
const { requiredJava } = require('./versions');

const MAX_META = 2 * 1024 * 1024;
const MAX_NESTED = 32 * 1024 * 1024;

function zipEntries(source, wanted) {
  return new Promise((resolve, reject) => {
    const open = Buffer.isBuffer(source) ? yauzl.fromBuffer : yauzl.open;
    open(source, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map(); let count = 0, total = 0;
      const fail = err => { zip.close(); reject(err); };
      zip.on('error', fail);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry => {
        if (++count > 50000) return fail(Error('JAR 내부 항목이 너무 많습니다.'));
        if (!wanted(entry.fileName)) return zip.readEntry();
        const max = entry.fileName.endsWith('.jar') ? MAX_NESTED : MAX_META;
        if (entry.uncompressedSize > max || (total += entry.uncompressedSize) > 64 * 1024 * 1024) return fail(Error('JAR 메타데이터 크기를 초과했습니다.'));
        zip.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          const chunks = []; let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => { size += chunk.length; if (size > max) { stream.destroy(); fail(Error('JAR 압축 해제 제한을 초과했습니다.')); } else chunks.push(chunk); });
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function versionMatches(version, range) {
  if (Array.isArray(range)) {const values=range.map(r=>versionMatches(version,r));return values.includes(true)?true:values.includes(null)?null:false;}
  if (!range || range === '*' || range === '') return true;
  if (typeof range !== 'string' || !version) return null;
  if (range === version) return true;
  const parsed = semver.valid(version) || semver.coerce(version)?.version;
  if (!parsed) return null;
  // Forge/NeoForge use Maven intervals; Fabric uses semantic version predicates.
  if (/^[[(]/.test(range)) {
    const intervals = [...range.matchAll(/([[(])([^\]\)]*)([\])])/g)];
    if (!intervals.length) return null;
    return intervals.some(([, left, body, right]) => {
      if (!body.includes(',')) return parsed === semver.coerce(body)?.version;
      const [min, max] = body.split(',').map(s => s.trim());
      const low = min ? semver.coerce(min)?.version : null, high = max ? semver.coerce(max)?.version : null;
      if ((min && !low) || (max && !high)) return false;
      return (!low || (left === '[' ? semver.gte(parsed, low) : semver.gt(parsed, low)))
        && (!high || (right === ']' ? semver.lte(parsed, high) : semver.lt(parsed, high)));
    });
  }
  const valid = semver.validRange(range);
  return valid ? semver.satisfies(parsed, valid, { includePrerelease: true }) : null;
}

async function readMods(source, file, depth = 0) {
  if (depth > 3) throw Error('중첩 모드의 깊이를 초과했습니다.');
  const entries = await zipEntries(source, name => ['fabric.mod.json','META-INF/mods.toml','META-INF/neoforge.mods.toml','META-INF/MANIFEST.MF'].includes(name)
    || /^(META-INF\/jars|META-INF\/jarjar)\/.+\.jar$/.test(name));
  const mods = [];
  if (entries.has('fabric.mod.json')) {
    const meta = JSON.parse(entries.get('fabric.mod.json').toString('utf8'));
    if (!meta.id || typeof meta.id !== 'string') throw Error('Fabric 모드 ID가 없습니다.');
    mods.push({ id: meta.id, version: String(meta.version || ''), name: String(meta.name || meta.id),
      loader: 'fabric', environment: meta.environment || '*', dependencies: meta.depends || {},
      conflicts: meta.breaks || {}, provides: meta.provides || [], file });
  }
  for (const entry of ['META-INF/neoforge.mods.toml','META-INF/mods.toml']) {
    if (!entries.has(entry)) continue;
    const meta = toml.parse(entries.get(entry).toString('utf8'));
    const implementation = entries.get('META-INF/MANIFEST.MF')?.toString('utf8').match(/^Implementation-Version:\s*(.+)$/m)?.[1].trim();
    const loader = entry.includes('neoforge') ? 'neoforge' : 'forge';
    for (const mod of meta.mods || []) {
      const deps = {};
      for (const dep of meta.dependencies?.[mod.modId] || []) {
        if (dep.side === 'SERVER' || dep.mandatory === false || (dep.type && dep.type !== 'required')) continue;
        deps[dep.modId] = dep.versionRange || '*';
      }
      mods.push({ id: mod.modId, version: String(mod.version || '').replace('${file.jarVersion}', implementation || ''),
        name: mod.displayName || mod.modId, loader, dependencies: deps, conflicts: {}, provides: [], file });
    }
  }
  for (const [name, buffer] of entries) if (name.endsWith('.jar')) mods.push(...await readMods(buffer, file, depth + 1));
  if (!mods.length && depth === 0) throw Error('지원하는 모드 메타데이터가 없습니다. 일반 플러그인이나 잘못된 JAR인지 확인하세요.');
  for (const mod of mods) mod.embedded ||= depth > 0;
  return mods;
}

async function inspectPack(files, channel) {
  const errors = [], warnings = [], mods = [];
  for (const file of files) {
    try {
      const candidates=await readMods(file.path,file.name);
      // Multi-loader JARs may contain both Fabric and Forge/NeoForge metadata.
      const compatible=candidates.some(m=>!m.embedded && m.loader===channel.loader);
      mods.push(...candidates.filter(m=>!compatible || m.loader===channel.loader));
    }
    catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  const providers = new Map();
  for (const mod of mods) {
    if (mod.loader !== channel.loader) errors.push(`${mod.file}: ${mod.loader} 모드입니다. 선택한 로더는 ${channel.loader}입니다.`);
    if (mod.environment === 'server') errors.push(`${mod.file}: 서버 전용 모드는 참가자에게 배포할 수 없습니다.`);
    if (providers.has(mod.id) && !mod.embedded && !providers.get(mod.id).embedded) errors.push(`모드 중복: ${mod.id} (${providers.get(mod.id).file}, ${mod.file})`);
    else if (providers.has(mod.id) && !mod.embedded) providers.set(mod.id, mod);
    else providers.set(mod.id, mod);
    for (const id of mod.provides || []) if (typeof id === 'string' && !providers.has(id)) providers.set(id, mod);
  }
  const builtins = { minecraft: channel.minecraft, java: String(requiredJava(channel.minecraft)),
    fabricloader: channel.loader === 'fabric' ? channel.loaderVersion : undefined,
    forge: channel.loader === 'forge' ? channel.loaderVersion : undefined,
    neoforge: channel.loader === 'neoforge' ? channel.loaderVersion : undefined };
  for (const mod of mods) {
    for (const [id, range] of Object.entries(mod.dependencies || {})) {
      const builtin = Object.prototype.hasOwnProperty.call(builtins, id);
      const provider = providers.get(id);
      if (!builtin && !provider) { errors.push(`${mod.file}: 필수 모드 ${id}가 없습니다.`); continue; }
      const version = builtin ? builtins[id] : provider.version;
      if (builtin && !version && ['fabricloader','forge','neoforge'].includes(id)) {
        warnings.push(`${mod.file}: ${id} ${JSON.stringify(range)} 필요. 정확한 로더 버전을 지정하면 검사할 수 있습니다.`); continue;
      }
      const matches = versionMatches(version, range);
      if (matches === false) errors.push(`${mod.file}: ${id} ${JSON.stringify(range)} 필요, 현재 ${version || '미설치'}.`);
      else if (matches === null) warnings.push(`${mod.file}: ${id} 버전 범위를 자동 판정할 수 없습니다 (${JSON.stringify(range)}).`);
    }
    for (const [id, range] of Object.entries(mod.conflicts || {})) if (providers.has(id)
      && versionMatches(providers.get(id).version, range) === true) errors.push(`${mod.file}: ${id} 모드와 호환되지 않습니다.`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)],
    mods: mods.map(({ id, version, name, file, loader }) => ({ id, version, name, file, loader })) };
}

module.exports = { inspectPack, readMods, versionMatches, zipEntries };
