'use strict';
const fs=require('fs-extra'),path=require('path'),os=require('os');
const {spawn}=require('child_process');
const {ensureRuntime}=require('../core/forge-runtime');
const root=path.resolve(__dirname,'../.test-data/forge-smoke');
const java=process.env.DEVKIT_TEST_JAVA || path.join(os.homedir(),'.mc-devkit','jre','bin','java.exe');
async function boot(type,version,port){
  const dir=path.join(root,type);await fs.ensureDir(dir);
  const runtime=await ensureRuntime(dir,type,'1.21.1',version,java,line=>console.log(line),{force:process.env.DEVKIT_FORCE_RUNTIME==='1'});
  await fs.writeFile(path.join(dir,'eula.txt'),'eula=true\n');
  await fs.writeFile(path.join(dir,'server.properties'),`server-port=${port}\nserver-ip=127.0.0.1\nonline-mode=false\nenable-rcon=false\nview-distance=2\nsimulation-distance=2\nlevel-name=smoke-world\n`);
  await new Promise((resolve,reject)=>{
    const child=spawn(java,['-Xmx1G','-Xms256M',...runtime.target.kind==='args'?[`@${runtime.target.path}`,'nogui']:['-jar',runtime.target.path,'nogui']],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let ready=false;const lines=[];
    const timer=setTimeout(()=>{child.kill();reject(Error(`${type} boot timed out`));},180000);
    for(const stream of ['stdout','stderr'])child[stream].on('data',d=>{const text=d.toString();lines.push(text);if(!ready && /Done \([\d.,]+s\)!/.test(text)){ready=true;console.log(`${type} ${version} booted successfully on isolated port ${port}; stopping.`);child.stdin.write('stop\n');}});
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',async code=>{clearTimeout(timer);await fs.writeFile(path.join(root,`${type}-boot.log`),lines.join(''));if(!ready || code!==0)reject(Error(`${type} failed: ${lines.join('').slice(-2000)}`));else resolve();});
  });
}
(async()=>{await boot('forge','52.1.0',38591);await boot('neoforge','21.1.200',38592);console.log('Both independent modded server runtimes installed, booted and stopped successfully.');})().catch(error=>{console.error(error);process.exitCode=1;});
