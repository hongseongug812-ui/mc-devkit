'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ModCatalog = require('../core/mod-catalog');
const { fabric } = require('./jar-fixture');

const CHANNEL_ID = 'a'.repeat(32);
const digest = (algorithm, value) => crypto.createHash(algorithm).update(value).digest('hex');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-catalog-'));
  const calls = [], published = [], projects = new Map(), versions = new Map(), downloads = new Map(), locks = new Map();
  let running = false;
  const channel = { id: CHANNEL_ID, minecraft: '1.21.1', loader: 'fabric', mode: 'development', sourceDir: path.join(root, 'client', 'mods') };
  const serverMods = path.join(root, 'server', 'mods');
  const publisher = {
    root: path.join(root, 'channels'),
    file: (id, name) => path.join(root, 'channels', id, name),
    readChannel: async id => { assert.equal(id, CHANNEL_ID); return { ...channel }; },
    save: async value => { Object.assign(channel, value); },
    serial(id, work) {
      const next = (locks.get(id) || Promise.resolve()).then(work, work);
      locks.set(id, next.catch(() => {}));
      return next;
    },
    publish: async value => { published.push(value); },
    view: async value => ({ id: value.id, sourceDir: value.sourceDir }),
  };
  const fallback = async (url, config) => {
    const endpoint = new URL(url).pathname;
    if (url.startsWith('https://cdn.modrinth.com/')) {
      assert.ok(downloads.has(url), `Unexpected artifact ${url}`);
      return downloads.get(url);
    }
    if (endpoint === '/v2/search') return { total_hits: projects.size, hits: [...projects.values()].map(project => ({ project_id: project.id, slug: project.id, title: project.title, description: project.description, downloads: 20, client_side: project.client_side, server_side: project.server_side })) };
    const version = endpoint.match(/^\/v2\/version\/([^/]+)$/);
    if (version) { assert.ok(versions.has(version[1]), `Unexpected version ${version[1]}`); return versions.get(version[1]); }
    const versionsList = endpoint.match(/^\/v2\/project\/([^/]+)\/version$/);
    if (versionsList) return [...versions.values()].filter(row => row.project_id === versionsList[1]);
    const project = endpoint.match(/^\/v2\/project\/([^/]+)$/);
    if (project) { assert.ok(projects.has(project[1]), `Unexpected project ${project[1]}`); return projects.get(project[1]); }
    assert.fail(`Unexpected request ${url} ${JSON.stringify(config)}`);
  };
  const request = async (url, config) => {
    calls.push({ url, config });
    return { data: options.respond ? await options.respond(url, config, fallback) : await fallback(url, config) };
  };
  const catalog = new ModCatalog(publisher, { request, isServerRunning: async () => running });
  function addProject(id, overrides = {}) {
    const project = { id, title: `Project ${id}`, description: `Description ${id}`, project_type: 'mod', client_side: 'required', server_side: 'required', ...overrides };
    projects.set(id, project);
    return project;
  }
  function addVersion(id, projectId, overrides = {}) {
    if (!projects.has(projectId)) addProject(projectId);
    const buffer = fabric(id, { id: projectId, depends: { minecraft: '1.21.1', fabricloader: '>=0.16.0' } });
    const url = `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${projectId}-${id}.jar`;
    downloads.set(url, buffer);
    const version = { id, project_id: projectId, name: id, version_number: id, game_versions: ['1.21.1'], loaders: ['fabric'], status: 'listed', version_type: 'release', date_published: '2026-01-01T00:00:00Z', dependencies: [],
      files: [{ primary: true, filename: `${projectId}-${id}.jar`, url, size: buffer.length, hashes: { sha512: digest('sha512', buffer) } }], ...overrides };
    versions.set(id, version);
    return version;
  }
  const addDefault = () => {
    addVersion('common1', 'common');
    addVersion('optional1', 'optional');
    addVersion('alpha1', 'alpha', { dependencies: [
      { dependency_type: 'required', project_id: 'common', version_id: 'common1' },
      { dependency_type: 'optional', project_id: 'optional', version_id: 'optional1' },
    ] });
  };
  const clientNames = async () => (await fs.readdir(channel.sourceDir).catch(() => [])).sort();
  const serverNames = async () => (await fs.readdir(serverMods).catch(() => [])).sort();
  t.after(async () => { catalog.close(); await Promise.all([...locks.values()]); await fs.remove(root); });
  return { root, channel, serverMods, publisher, catalog, calls, published, projects, versions, downloads,
    addProject, addVersion, addDefault, clientNames, serverNames, setRunning: value => { running = value; } };
}

test('catalog search sends exact Minecraft and loader facets and validates query pagination', async t => {
  const f = await fixture(t);
  f.addProject('alpha');
  const result = await f.catalog.search(f.channel, '  performance  ', 20);
  assert.equal(result.provider, 'Modrinth');
  assert.equal(result.hits[0].projectId, 'alpha');
  const config = f.calls[0].config;
  assert.equal(config.params.query, 'performance');
  assert.equal(config.params.offset, 20);
  assert.deepEqual(JSON.parse(config.params.facets), [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric']]);
  assert.equal(config.maxRedirects, 0);
  assert.equal(config.timeout, 20000);
  await assert.rejects(f.catalog.search(f.channel, 'x', -1));
  await assert.rejects(f.catalog.search(f.channel, 'x'.repeat(121)));
  await assert.rejects(f.catalog.search({ ...f.channel, loader: 'none' }, 'x'));
  assert.equal(f.calls.length, 1);
});

test('version selection filters exact game/loader and status, then chooses a stable compatible release', async t => {
  const f = await fixture(t);
  f.addVersion('old', 'alpha');
  f.addVersion('release', 'alpha', { date_published: '2026-02-01T00:00:00Z' });
  f.addVersion('beta', 'alpha', { date_published: '2026-03-01T00:00:00Z', version_type: 'beta' });
  f.addVersion('wronggame', 'alpha', { game_versions: ['1.21.2'], date_published: '2026-04-01T00:00:00Z' });
  f.addVersion('wrongloader', 'alpha', { loaders: ['forge'], date_published: '2026-04-01T00:00:00Z' });
  f.addVersion('archived', 'alpha', { status: 'archived', date_published: '2026-04-01T00:00:00Z' });
  assert.deepEqual((await f.catalog.versions(f.channel, 'alpha')).versions.map(row => row.id), ['beta', 'release', 'old']);
  const result = await f.catalog.resolve(f.channel, [{ projectId: 'alpha', target: 'both' }]);
  assert.equal(result.roots[0].versionId, 'release');
  assert.equal(result.plan[0].version.id, 'release');
});

test('install resolves required dependencies for both sides, ignores optional dependencies, and records verified artifacts', async t => {
  const f = await fixture(t);
  f.addDefault();
  const result = await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
  assert.deepEqual(await f.serverNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
  assert.deepEqual(result.installed.map(row => row.projectId).sort(), ['alpha', 'common']);
  assert.equal(result.installed.every(row => row.sides.includes('server') && row.sides.includes('client')), true);
  const state = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
  assert.deepEqual(state.roots, [{ projectId: 'alpha', versionId: 'alpha1', target: 'both', autoUpdate: true }]);
  assert.equal(state.files.length, 4);
  for (const record of state.files) assert.equal(digest('sha256', await fs.readFile(path.join(record.dir, record.name))), record.sha256);
  assert.equal(f.calls.filter(call => call.url.startsWith('https://cdn.modrinth.com/')).length, 2);
  assert.equal(f.calls.some(call => call.url.includes('/optional/')), false);
  assert.equal(f.published.length, 1);
});

test('an already resolved dependency can also be an explicit root without changing the chosen version', async t => {
  const f = await fixture(t);
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'common1' });
  const state = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
  assert.deepEqual(state.roots.map(row => row.projectId), ['alpha', 'common']);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
});

test('incompatible explicit versions and conflicting required dependency pins fail before touching game files', async t => {
  const f = await fixture(t);
  f.addDefault();
  f.addVersion('wronggame', 'alpha', { game_versions: ['1.21.2'] });
  f.addVersion('wrongloader', 'alpha', { loaders: ['forge'] });
  for (const versionId of ['wronggame', 'wrongloader']) await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId }));
  f.addVersion('common2', 'common');
  f.addVersion('beta1', 'beta', { dependencies: [{ dependency_type: 'required', project_id: 'common', version_id: 'common2' }] });
  await assert.rejects(f.catalog.resolve(f.channel, [
    { projectId: 'alpha', versionId: 'alpha1', target: 'both' },
    { projectId: 'beta', versionId: 'beta1', target: 'both' },
  ]));
  assert.deepEqual(await f.clientNames(), []);
  assert.deepEqual(await f.serverNames(), []);
  assert.equal(f.calls.some(call => call.url.startsWith('https://cdn.modrinth.com/')), false);
});

test('client-only mods reject both-side installation and can be installed while the server runs', async t => {
  const f = await fixture(t);
  f.addProject('clientonly', { server_side: 'unsupported' });
  f.addVersion('client1', 'clientonly');
  await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId: 'client1', target: 'both' }));
  f.setRunning(true);
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'client1', target: 'client' });
  assert.deepEqual(await f.clientNames(), ['clientonly-client1.jar']);
  assert.deepEqual(await f.serverNames(), []);
});

test('moving a managed server mod to client-only waits for the server to stop, including starts during download', async t => {
  for (const startsDuringDownload of [false, true]) {
    let f, moving = false;
    f = await fixture(t, { respond: async (url, config, fallback) => {
      const result = await fallback(url, config);
      if (moving && startsDuringDownload && url.startsWith('https://cdn.modrinth.com/')) f.setRunning(true);
      return result;
    } });
    f.addVersion('alpha1', 'alpha');
    await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
    const before = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
    f.addVersion('alpha2', 'alpha');
    moving = true;
    f.setRunning(!startsDuringDownload);
    await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha2', target: 'client' }), /서버/);
    assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar']);
    assert.deepEqual(await f.serverNames(), ['alpha-alpha1.jar']);
    assert.deepEqual(await fs.readJson(f.catalog.registryFile(CHANNEL_ID)), before);
    moving = false;
    f.setRunning(false);
    await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha2', target: 'client' });
    assert.deepEqual(await f.clientNames(), ['alpha-alpha2.jar']);
    assert.deepEqual(await f.serverNames(), []);
  }
});

test('a checksum failure after dependency download leaves existing files and registry untouched', async t => {
  const f = await fixture(t);
  f.addDefault();
  const version = f.versions.get('alpha1');
  f.downloads.set(version.files[0].url, Buffer.alloc(version.files[0].size, 0));
  await fs.outputFile(path.join(f.channel.sourceDir, 'personal.jar'), 'personal');
  await fs.outputFile(path.join(f.serverMods, 'personal.jar'), 'server-personal');
  await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' }));
  assert.deepEqual(await f.clientNames(), ['personal.jar']);
  assert.deepEqual(await f.serverNames(), ['personal.jar']);
  assert.equal(await fs.readFile(path.join(f.channel.sourceDir, 'personal.jar'), 'utf8'), 'personal');
  assert.equal(await fs.pathExists(f.catalog.registryFile(CHANNEL_ID)), false);
  assert.equal(f.published.length, 0);
  assert.deepEqual(await fs.readdir(f.publisher.file(CHANNEL_ID, 'catalog-staging')), []);
});

test('downloads reject untrusted hosts, traversal filenames, missing hashes, and incorrect JAR loader metadata', async t => {
  for (const failure of ['host', 'filename', 'hash', 'loader']) {
    const f = await fixture(t);
    const version = f.addVersion('alpha1', 'alpha');
    if (failure === 'host') version.files[0].url = 'https://cdn.modrinth.com.evil.example/mod.jar';
    if (failure === 'filename') version.files[0].filename = '../escape.jar';
    if (failure === 'hash') version.files[0].hashes = {};
    if (failure === 'loader') {
      const buffer = require('./jar-fixture').zip({ 'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="alpha"\nversion="1.0.0"' });
      version.files[0].size = buffer.length;
      version.files[0].hashes.sha512 = digest('sha512', buffer);
      f.downloads.set(version.files[0].url, buffer);
    }
    await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' }), failure);
    assert.deepEqual(await f.clientNames(), [], failure);
    assert.deepEqual(await f.serverNames(), [], failure);
    assert.equal(await fs.pathExists(path.join(f.root, 'client', 'escape.jar')), false);
    if (failure !== 'loader') assert.equal(f.calls.some(call => call.url.startsWith('https://cdn.modrinth.com/')), false);
  }
});

test('automatic updates replace only managed old artifacts and preserve personal mods and settings', async t => {
  const f = await fixture(t);
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  await fs.outputFile(path.join(f.channel.sourceDir, 'personal.jar'), 'client-personal');
  await fs.outputFile(path.join(f.serverMods, 'personal.jar'), 'server-personal');
  await fs.outputFile(path.join(f.root, 'client', 'options.txt'), 'keybinds');
  const newVersion = f.addVersion('alpha2', 'alpha', { date_published: '2026-02-01T00:00:00Z', dependencies: f.versions.get('alpha1').dependencies });
  f.addVersion('future', 'alpha', { game_versions: ['1.21.2'], date_published: '2026-03-01T00:00:00Z' });
  f.addVersion('beta', 'alpha', { version_type: 'beta', date_published: '2026-03-01T00:00:00Z' });
  await f.catalog.update(CHANNEL_ID, true);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha2.jar', 'common-common1.jar', 'personal.jar']);
  assert.deepEqual(await f.serverNames(), ['alpha-alpha2.jar', 'common-common1.jar', 'personal.jar']);
  assert.deepEqual(await fs.readFile(path.join(f.serverMods, 'alpha-alpha2.jar')), f.downloads.get(newVersion.files[0].url));
  assert.equal(await fs.readFile(path.join(f.channel.sourceDir, 'personal.jar'), 'utf8'), 'client-personal');
  assert.equal(await fs.readFile(path.join(f.root, 'client', 'options.txt'), 'utf8'), 'keybinds');
  assert.equal((await fs.readJson(f.catalog.registryFile(CHANNEL_ID))).roots[0].versionId, 'alpha2');
});

test('locally edited managed jars and colliding personal files block replacement without deleting either', async t => {
  const f = await fixture(t);
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  const oldRegistry = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
  f.addVersion('alpha2', 'alpha', { date_published: '2026-02-01T00:00:00Z' });
  const managed = path.join(f.channel.sourceDir, 'alpha-alpha1.jar');
  await fs.writeFile(managed, 'edited-managed');
  await assert.rejects(f.catalog.update(CHANNEL_ID, true));
  assert.equal(await fs.readFile(managed, 'utf8'), 'edited-managed');
  assert.deepEqual(await fs.readJson(f.catalog.registryFile(CHANNEL_ID)), oldRegistry);
  await fs.writeFile(managed, f.downloads.get(f.versions.get('alpha1').files[0].url));
  const personalCollision = path.join(f.channel.sourceDir, 'alpha-alpha2.jar');
  await fs.writeFile(personalCollision, 'personal-collision');
  await assert.rejects(f.catalog.update(CHANNEL_ID, true));
  assert.equal(await fs.readFile(personalCollision, 'utf8'), 'personal-collision');
  assert.equal(await fs.pathExists(path.join(f.serverMods, 'alpha-alpha1.jar')), true);
  assert.deepEqual(await fs.readJson(f.catalog.registryFile(CHANNEL_ID)), oldRegistry);
});

test('running servers and filming mode block installation, including state changes during download', async t => {
  for (const block of ['running', 'filming', 'running-during-download', 'filming-during-download']) {
    let f;
    f = await fixture(t, { respond: async (url, config, fallback) => {
      const result = await fallback(url, config);
      if (url.startsWith('https://cdn.modrinth.com/')) {
        if (block === 'running-during-download') f.setRunning(true);
        if (block === 'filming-during-download') f.channel.mode = 'filming';
      }
      return result;
    } });
    f.addDefault();
    if (block === 'running') f.setRunning(true);
    if (block === 'filming') f.channel.mode = 'filming';
    await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' }), block);
    assert.deepEqual(await f.clientNames(), [], block);
    assert.deepEqual(await f.serverNames(), [], block);
    assert.equal(await fs.pathExists(f.catalog.registryFile(CHANNEL_ID)), false);
    if (block === 'running' || block === 'filming') assert.equal(f.calls.some(call => call.url.startsWith('https://cdn.modrinth.com/')), false);
  }
});

test('a mid-commit filesystem failure rolls back new files and restores every prior managed artifact and registry', async t => {
  const f = await fixture(t);
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  const oldRegistry = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
  f.addVersion('common2', 'common', { date_published: '2026-02-01T00:00:00Z' });
  f.addVersion('alpha2', 'alpha', { date_published: '2026-02-01T00:00:00Z', dependencies: [{ dependency_type: 'required', project_id: 'common', version_id: 'common2' }] });
  const originalCopy = fs.copyFile;
  fs.copyFile = async (source, destination, ...args) => {
    if (destination === path.join(f.channel.sourceDir, 'alpha-alpha2.jar')) throw Object.assign(Error('simulated disk failure'), { code: 'EIO' });
    return originalCopy(source, destination, ...args);
  };
  try { await assert.rejects(f.catalog.update(CHANNEL_ID, true), /simulated disk failure/); }
  finally { fs.copyFile = originalCopy; }
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
  assert.deepEqual(await f.serverNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
  for (const record of oldRegistry.files) assert.equal(digest('sha256', await fs.readFile(path.join(record.dir, record.name))), record.sha256);
  assert.deepEqual(await fs.readJson(f.catalog.registryFile(CHANNEL_ID)), oldRegistry);
  assert.deepEqual(await fs.readdir(f.publisher.file(CHANNEL_ID, 'catalog-staging')), []);
});

test('global and per-root automatic update opt-outs retain pins, while a manual update can advance them', async t => {
  const f = await fixture(t);
  f.addVersion('alpha1', 'alpha');
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1', autoUpdate: false });
  f.addVersion('alpha2', 'alpha', { date_published: '2026-02-01T00:00:00Z' });
  await f.catalog.update(CHANNEL_ID, true);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar']);
  await f.catalog.settings(CHANNEL_ID, false);
  const requestCount = f.calls.length;
  await f.catalog.update(CHANNEL_ID, true);
  assert.equal(f.calls.length, requestCount);
  await f.catalog.update(CHANNEL_ID, false);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha2.jar']);
  assert.equal((await f.catalog.installed(CHANNEL_ID)).autoUpdate, false);
  await assert.rejects(f.catalog.settings(CHANNEL_ID, 'false'));
});

test('background update failures keep installed bytes and expose only sanitized catalog errors', async t => {
  let offline = false;
  const f = await fixture(t, { respond: async (url, config, fallback) => {
    if (offline) throw Object.assign(Error('private-token-and-server-body'), { isAxiosError: true, response: { status: 500, data: 'private-secret' } });
    return fallback(url, config);
  } });
  f.addVersion('alpha1', 'alpha');
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  offline = true;
  await f.catalog.checkAll();
  const state = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
  assert.ok(state.error);
  assert.equal(JSON.stringify(state).includes('private-'), false);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar']);
  assert.deepEqual(await f.serverNames(), ['alpha-alpha1.jar']);
});

test('incompatible project or version declarations reject a shared-side plan before artifact download', async t => {
  for (const incompatible of [{ project_id: 'beta' }, { version_id: 'beta1' }]) {
    const f = await fixture(t);
    f.addVersion('beta1', 'beta');
    f.addVersion('alpha1', 'alpha', { dependencies: [{ dependency_type: 'incompatible', ...incompatible }] });
    await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
    const before = await fs.readJson(f.catalog.registryFile(CHANNEL_ID));
    const requestCount = f.calls.filter(call => call.url.startsWith('https://cdn.modrinth.com/')).length;
    await assert.rejects(f.catalog.install(f.channel, f.serverMods, { versionId: 'beta1' }));
    assert.equal(f.calls.filter(call => call.url.startsWith('https://cdn.modrinth.com/')).length, requestCount);
    assert.deepEqual(await fs.readJson(f.catalog.registryFile(CHANNEL_ID)), before);
    assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar']);
  }
});

test('version-specific incompatibilities allow other versions and opposite installation sides', async t => {
  const f = await fixture(t);
  f.addVersion('beta1', 'beta');
  f.addVersion('beta2', 'beta');
  f.addVersion('alpha1', 'alpha', { dependencies: [{ dependency_type: 'incompatible', project_id: 'beta', version_id: 'beta1' }] });
  const roots = [{ projectId: 'alpha', versionId: 'alpha1', target: 'both' }, { projectId: 'beta', versionId: 'beta2', target: 'both' }];
  assert.equal((await f.catalog.resolve(f.channel, roots)).plan.length, 2);
  assert.equal((await f.catalog.resolve(f.channel, [
    { projectId: 'alpha', versionId: 'alpha1', target: 'client' },
    { projectId: 'beta', versionId: 'beta1', target: 'server' },
  ])).plan.length, 2);
});

test('custom client publication patterns include all installed client artifacts and retain the previous rule', async t => {
  const f = await fixture(t);
  f.channel.patterns = ['studio-*.jar'];
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  assert.ok(f.channel.patterns.includes('studio-*.jar'));
  assert.ok(f.channel.patterns.includes('alpha-alpha1.jar'));
  assert.ok(f.channel.patterns.includes('common-common1.jar'));
  assert.deepEqual(f.published[0].patterns, f.channel.patterns);
  f.addVersion('alpha2', 'alpha', { date_published: '2026-02-01T00:00:00Z', dependencies: f.versions.get('alpha1').dependencies });
  await f.catalog.update(CHANNEL_ID, true);
  assert.ok(f.channel.patterns.includes('studio-*.jar'));
  assert.ok(f.channel.patterns.includes('alpha-alpha2.jar'));
  assert.equal(f.channel.patterns.includes('alpha-alpha1.jar'), false);
});

test('unchanged automatic checks verify cached managed jars without downloading them again', async t => {
  const f = await fixture(t);
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  const downloadCount = f.calls.filter(call => call.url.startsWith('https://cdn.modrinth.com/')).length;
  const callsBefore = f.calls.length;
  await f.catalog.update(CHANNEL_ID, true);
  assert.ok(f.calls.length > callsBefore, 'upstream metadata is still checked');
  assert.equal(f.calls.filter(call => call.url.startsWith('https://cdn.modrinth.com/')).length, downloadCount);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
});

test('automatic checks keep an explicitly installed beta until a newer stable release is available', async t => {
  const f = await fixture(t);
  f.addVersion('stableold', 'alpha', { date_published: '2026-01-01T00:00:00Z' });
  f.addVersion('betanew', 'alpha', { date_published: '2026-02-01T00:00:00Z', version_type: 'beta' });
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'betanew' });
  await f.catalog.update(CHANNEL_ID, true);
  assert.deepEqual(await f.clientNames(), ['alpha-betanew.jar']);
  f.addVersion('stablenew', 'alpha', { date_published: '2026-03-01T00:00:00Z' });
  await f.catalog.update(CHANNEL_ID, true);
  assert.deepEqual(await f.clientNames(), ['alpha-stablenew.jar']);
});

test('the installed summary reports each root automatic-update opt-out independently', async t => {
  const f = await fixture(t);
  f.addVersion('alpha1', 'alpha');
  f.addVersion('beta1', 'beta');
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1', autoUpdate: false });
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'beta1' });
  const summary = await f.catalog.installed(CHANNEL_ID);
  assert.equal(summary.autoUpdate, true);
  assert.equal(summary.installed.find(row => row.projectId === 'alpha').autoUpdate, false);
  assert.equal(summary.installed.find(row => row.projectId === 'beta').autoUpdate, true);
});

test('a normal set of more than fifty independent mods does not count as a deep dependency chain', async t => {
  const f = await fixture(t);
  const roots = [];
  for (let i = 0; i < 60; i++) {
    f.addVersion(`version${i}`, `project${i}`);
    roots.push({ projectId: `project${i}`, versionId: `version${i}`, target: 'both' });
  }
  const result = await f.catalog.resolve(f.channel, roots);
  assert.equal(result.plan.length, 60);
  assert.equal(f.calls.some(call => call.url.startsWith('https://cdn.modrinth.com/')), false);
});

test('retired server environments cannot restore outdated mods into a reused server directory', async t => {
  const f = await fixture(t);
  f.addDefault();
  await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
  const before = f.calls.length;
  f.catalog.isChannelCurrent = async () => false;
  await assert.rejects(f.catalog.update(CHANNEL_ID, true), /버전·로더 설정이 변경/);
  assert.equal(f.calls.length, before);
  assert.deepEqual(await f.clientNames(), ['alpha-alpha1.jar', 'common-common1.jar']);
});

test('server environment changes during download block first installs and updates before committing files', async t => {
  for (const alreadyInstalled of [false, true]) {
    let f, changing = false, current = true, checks = 0;
    f = await fixture(t, { respond: async (url, config, fallback) => {
      const result = await fallback(url, config);
      if (changing && url.startsWith('https://cdn.modrinth.com/')) current = false;
      return result;
    } });
    f.catalog.isChannelCurrent = async (channel, state) => {
      assert.equal(state.serverModsDir, f.serverMods, 'even a first install validates its intended server directory');
      checks++;
      return current;
    };
    f.addVersion('alpha1', 'alpha');
    if (alreadyInstalled) await f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha1' });
    const before = alreadyInstalled ? await fs.readJson(f.catalog.registryFile(CHANNEL_ID)) : null;
    f.addVersion('alpha2', 'alpha', { date_published: '2026-02-01T00:00:00Z' });
    checks = 0;
    changing = true;
    await assert.rejects(alreadyInstalled ? f.catalog.update(CHANNEL_ID, true)
      : f.catalog.install(f.channel, f.serverMods, { versionId: 'alpha2' }), /다운로드 중 서버의 Minecraft/);
    assert.equal(checks, 2);
    assert.equal(f.catalog.committing, false);
    assert.deepEqual(await f.clientNames(), alreadyInstalled ? ['alpha-alpha1.jar'] : []);
    assert.deepEqual(await f.serverNames(), alreadyInstalled ? ['alpha-alpha1.jar'] : []);
    if (before) assert.deepEqual(await fs.readJson(f.catalog.registryFile(CHANNEL_ID)), before);
    else assert.equal(await fs.pathExists(f.catalog.registryFile(CHANNEL_ID)), false);
  }
});
