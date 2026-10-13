'use strict';

class AutomaticUpdates {
  constructor(updater,{isIdle,beforeInstall,onStatus=()=>{},setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}) {
    this.updater=updater;this.isIdle=isIdle;this.beforeInstall=beforeInstall;this.onStatus=onStatus;
    this.setInterval=setIntervalFn;this.clearInterval=clearIntervalFn;this.ready=false;this.installing=false;this.checking=null;this.attempting=null;
    updater.autoDownload=true;updater.autoInstallOnAppQuit=true;updater.autoRunAppAfterInstall=true;updater.disableWebInstaller=true;
    this.downloaded=()=>{this.ready=true;this.onStatus('ready');this.attemptInstall().catch(()=>{});};
    this.available=()=>this.onStatus('downloading');
    updater.on('update-downloaded',this.downloaded);updater.on('update-available',this.available);
  }
  start(){
    this.checkTimer=this.setInterval(()=>this.check().catch(()=>{}),15*60*1000);this.checkTimer.unref?.();
    this.installTimer=this.setInterval(()=>this.attemptInstall().catch(()=>{}),30*1000);this.installTimer.unref?.();
    this.check().catch(()=>{});
  }
  check(){
    if(this.checking)return this.checking;
    if(this.ready)return this.attemptInstall();
    const job=Promise.resolve().then(()=>this.updater.checkForUpdates());this.checking=job;
    job.finally(()=>{if(this.checking===job)this.checking=null;}).catch(()=>{});return job;
  }
  attemptInstall(){
    if(!this.ready || this.installing)return Promise.resolve(false);
    if(this.attempting)return this.attempting;
    const job=(async()=>{
      if(!await this.isIdle() || !this.ready || this.installing)return false;
      this.installing=true;this.onStatus('installing');
      try {
        // Finish local writes and release the server before launching the installer.
        await this.beforeInstall();
        this.updater.quitAndInstall(true,true);return true;
      }catch(e){this.installing=false;this.onStatus('error');throw e;}
    })();
    this.attempting=job;job.finally(()=>{if(this.attempting===job)this.attempting=null;}).catch(()=>{});return job;
  }
  close(){this.clearInterval(this.checkTimer);this.clearInterval(this.installTimer);this.updater.removeListener('update-downloaded',this.downloaded);this.updater.removeListener('update-available',this.available);}
}
module.exports=AutomaticUpdates;
