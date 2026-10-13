'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

async function gameRunning() {
  // Inspect arguments, not just java.exe: a host can run a server while syncing a client.
  let output;
  if (process.platform === 'win32') {
    try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process -Filter "Name = \'java.exe\' OR Name = \'javaw.exe\'" | Select-Object CommandLine | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    const rows = JSON.parse(result.stdout.trim() || '[]');
    const processes = Array.isArray(rows) ? rows : [rows];
    if (processes.some(p => !p.CommandLine)) throw new Error('게임 프로세스 확인 권한이 없습니다. 자동 적용을 잠시 중지합니다.');
    output = processes.map(p => p.CommandLine).join('\n');
    } catch {
      // Some Windows accounts cannot use CIM. A conservative process-name check
      // still permits syncing when no Java processes are running.
      try {
        const result = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
        return /"javaw?\.exe"/i.test(result.stdout);
      } catch { throw new Error('게임 실행 상태를 확인할 수 없습니다. 프로세스 조회 권한을 확인하세요.'); }
    }
  } else {
    output = (await run('ps', ['-axo', 'args='], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  }
  return /net\.minecraft\.client|net\.fabricmc\.loader.*KnotClient|--(?:gameDir|accessToken|launchTarget\s+(?:forge|neoforge)client)|org\.multimc\.EntryPoint|org\.prismlauncher\.EntryPoint/i.test(output);
}

module.exports = { gameRunning };
