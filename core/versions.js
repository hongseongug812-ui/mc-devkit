'use strict';

const axios = require('axios');
const USER_AGENT = `MC-DevKit/${require('../package.json').version} (https://github.com/hongseongug812-ui/mc-devkit)`;
const MOJANG_META = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const options = { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 };
const cache = new Map();

function sortVersions(versions) {
  return [...new Set(versions)].filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))
    .sort((a, b) => {
      const av = a.split('.').map(Number), bv = b.split('.').map(Number);
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        if ((bv[i] || 0) !== (av[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
      }
      return 0;
    });
}

function requiredJava(version) {
  const [major, minor, patch = 0] = String(version).split('.').map(Number);
  if (major >= 26) return 25;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor >= 17) return 16;
  return 8;
}

async function listVersions(type, refresh = false) {
  const saved = cache.get(type);
  if (!refresh && saved && Date.now() - saved.at < 300000) return saved.value;
  let value;
  if (type === 'paper') {
    const { data } = await axios.get(PAPER_API, options);
    value = sortVersions(Object.values(data.versions).flat());
  } else if (type === 'fabric') {
    const { data } = await axios.get('https://meta.fabricmc.net/v2/versions/game', options);
    value = sortVersions(data.filter(v => v.stable).map(v => v.version));
  } else if (type === 'vanilla') {
    const { data } = await axios.get(MOJANG_META, options);
    value = sortVersions(data.versions.filter(v => v.type === 'release').map(v => v.id));
  } else if (type === 'cardboard') {
    const { data } = await axios.get('https://api.modrinth.com/v2/project/cardboard', options);
    value = sortVersions(data.game_versions || []);
  } else if (type === 'arclight') {
    const { data } = await axios.get('https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=100', options);
    value = sortVersions(data.filter(r => !r.prerelease && !r.draft).flatMap(r =>
      r.assets.map(a => a.name.match(/arclight-(?:forge|neoforge|fabric)-(\d+\.\d+(?:\.\d+)?)-/)?.[1]).filter(Boolean)));
  } else throw new Error('지원하지 않는 서버 종류입니다.');
  if (!value.length) throw new Error('사용 가능한 안정 버전이 없습니다.');
  cache.set(type, { at: Date.now(), value });
  return value;
}

async function paperBuild(version) {
  const { data } = await axios.get(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds`, options);
  const build = data.filter(b => b.channel === 'STABLE').sort((a, b) => b.id - a.id)[0];
  if (!build?.downloads?.['server:default']) throw new Error(`Paper ${version}의 안정 빌드가 아직 없습니다. 다른 버전을 선택하세요.`);
  return { id: build.id, ...build.downloads['server:default'] };
}

module.exports = { sortVersions, requiredJava, listVersions, paperBuild, USER_AGENT, MOJANG_META };
