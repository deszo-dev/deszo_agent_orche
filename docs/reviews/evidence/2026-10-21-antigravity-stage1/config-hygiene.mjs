// No inference, authentication-store access or broad configuration reset.
import assert from 'node:assert/strict';
import { readFile,writeFile,copyFile,rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const folder=fileURLToPath(new URL('.',import.meta.url));
const expectedServer=resolve(folder,'../2026-10-21-antigravity-judge-e2e/lib/evidence-mcp-server.mjs');
const files=['.gemini/config/mcp_config.json','.gemini/antigravity-cli/settings.json'];
const loaded=await Promise.all(files.map(async relative=>{
  const path=join(homedir(),relative),bytes=await readFile(path);
  assert.ok(bytes.length<=1024*1024,'Refuse unexpectedly large user configuration.');
  const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  return {relative,path,bytes,value,next:structuredClone(value)};
}));
const [mcp,settings]=loaded,server=mcp.value.mcpServers?.['deszo-evidence'];
const provenOwned=Boolean(server&&Array.isArray(server.args)&&server.args.length===1&&resolve(server.args[0])===expectedServer&&/node(?:\.exe)?$/i.test(server.command)&&!Object.keys(server.env||{}).length);
if(server&&!provenOwned)throw new Error('deszo-evidence is not the exact archived PoC registration; manual reconciliation required.');
if(provenOwned){
  delete mcp.next.mcpServers['deszo-evidence'];
  if(Array.isArray(settings.next.permissions?.allow))settings.next.permissions.allow=settings.next.permissions.allow.filter(x=>x!=='mcp(deszo-evidence/*)');
}
const apply=process.argv.includes('--apply'),receipt={schemaVersion:1,kind:'Stage1ConfigurationHygiene',mode:apply?'apply':'inspect',recordedAt:new Date().toISOString(),provenPocRegistration:provenOwned,authenticationStoresRead:false,providerCalls:0,files:[]};
for(const item of loaded){
  const changed=JSON.stringify(item.value)!==JSON.stringify(item.next),after=changed?Buffer.from(JSON.stringify(item.next,null,2)+'\n','utf8'):item.bytes;
  let backup=null;
  if(apply&&changed){
    assert.equal(sha(await readFile(item.path)),sha(item.bytes),'Configuration changed concurrently; do not overwrite it.');
    backup=`${item.relative}.stage1-poc-backup-${sha(item.bytes).slice(0,12)}.json`;
    try{await copyFile(item.path,join(homedir(),backup),constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(sha(await readFile(join(homedir(),backup))),sha(item.bytes));}
    const temporary=`${item.path}.stage1-${process.pid}.tmp`;
    await writeFile(temporary,after,{flag:'wx',mode:0o600});await rename(temporary,item.path);
    assert.deepEqual(JSON.parse((await readFile(item.path)).toString('utf8')),item.next);
  }
  receipt.files.push({relative:item.relative,changed:apply&&changed,wouldChange:changed,beforeSha256:sha(item.bytes),afterSha256:sha(apply?after:item.bytes),backupBesideOriginal:backup,utf8BomAfter:after.subarray(0,3).equals(Buffer.from([239,187,191])),unrelatedSemanticsPreserved:true});
}
if(apply)await writeFile(join(folder,'config-hygiene.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
