'use strict';
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { version, build } = require('../package.json');

(async () => {
  const dist = path.resolve(__dirname, '../dist');
  const manifest = yaml.load(await fs.readFile(path.join(dist, 'latest.yml'), 'utf8'));
  const expectedName = `MC-DevKit-Setup-${version}.exe`;
  if (manifest.version !== version || manifest.path !== expectedName || manifest.files[0].url !== expectedName) throw Error('Release manifest does not match package version or asset name');
  const source = path.join(dist, `MC DevKit Setup ${version}.exe`);
  const stat = await fs.stat(source);
  const hash = crypto.createHash('sha512');
  for await (const bytes of fs.createReadStream(source)) hash.update(bytes);
  const sha512 = hash.digest('base64');
  if (manifest.sha512 !== sha512 || manifest.files[0].sha512 !== sha512 || manifest.files[0].size !== stat.size) throw Error('Release metadata checksum or size mismatch');
  const config = yaml.load(await fs.readFile(path.join(dist, 'win-unpacked/resources/app-update.yml'), 'utf8'));
  if (config.provider !== build.publish.provider || config.owner !== build.publish.owner || config.repo !== build.publish.repo) throw Error('Packaged update provider mismatch');
  const stage = path.resolve(__dirname, '../.test-data/release');
  await fs.ensureDir(stage);
  await fs.copyFile(source, path.join(stage, expectedName));
  await fs.copyFile(`${source}.blockmap`, path.join(stage, `${expectedName}.blockmap`));
  await fs.copyFile(path.join(dist, 'latest.yml'), path.join(stage, 'latest.yml'));
  console.log(`Verified ${version}: installer ${stat.size} bytes; SHA-512 matches; update provider ${config.owner}/${config.repo}; 3 release assets staged.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
