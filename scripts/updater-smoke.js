'use strict';
// Verify the public update feed and installer using the real updater. Never install.
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { app } = require('electron');
const root = path.resolve(__dirname, '../.test-data/updater');
fs.ensureDirSync(path.join(root, 'userData'));
app.setPath('userData', path.join(root, 'userData'));
app.setPath('sessionData', path.join(root, 'userData'));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const { NsisUpdater } = require('electron-updater');
  const updater = new NsisUpdater(require('../package.json').build.publish);
  updater.forceDevUpdateConfig = true;
  updater.currentVersion = require('semver').parse('1.7.20');
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
  updater.disableDifferentialDownload = true;
  updater.updateConfigPath = path.resolve(__dirname, '../dist/win-unpacked/resources/app-update.yml');
  Object.defineProperty(updater.app, 'baseCachePath', { value: path.join(root, 'cache') });
  const result = await updater.checkForUpdates();
  const expectedVersion = require('../package.json').version;
  if (result?.updateInfo.version !== expectedVersion) throw Error(`Expected ${expectedVersion}, received ${result?.updateInfo.version}`);
  console.log(`Public GitHub updater detected ${expectedVersion} from 1.7.20.`);
  const files = await updater.downloadUpdate();
  const local = path.resolve(__dirname, `../dist/MC DevKit Setup ${expectedVersion}.exe`);
  const hash = async file => {
    const digest = crypto.createHash('sha512');
    for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
    return digest.digest('base64');
  };
  if (!files.length || await hash(files[0]) !== await hash(local)) throw Error('Downloaded installer differs from verified local build');
  console.log('Public installer download passed SHA-512 verification. Installation was not invoked.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
