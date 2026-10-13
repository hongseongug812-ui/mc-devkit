'use strict';
const { listVersions, paperBuild, requiredJava } = require('../core/versions');
(async () => {
  const results = await Promise.allSettled(['paper','fabric','vanilla','arclight','cardboard'].map(async type => {
    const versions=await listVersions(type,true);
    console.log(`${type}: ${versions[0]} (${versions.length} releases), Java ${requiredJava(versions[0])}+`);
    if(type==='paper') {
      const build=await paperBuild(versions[0]);
      if(!build.url || !(build.checksums?.sha256 || build.sha256)) throw Error('Paper download metadata lacks checksum');
      console.log(`Paper stable build ${build.id}: checksum present`);
    }
  }));
  for(const result of results) if(result.status==='rejected') {console.error(result.reason.message);process.exitCode=1;}
})();
