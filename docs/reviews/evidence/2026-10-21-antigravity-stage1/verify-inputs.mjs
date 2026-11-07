// Bind test evidence to exact runtime/Bridge/Host/schema/script inputs without exporting source or credentials.
import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const receiptPath=new URL('source-inputs.json',import.meta.url),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','runtime','mcp','docs/schemas','docs/storage','scripts','package.json','package-lock.json'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const files=[];
for(const path of paths)files.push({path,sha256:sha(await readFile(new URL(path,new URL('../../../../',import.meta.url))))});
const fingerprint=sha(JSON.stringify(files));
if(process.argv.includes('--capture')){
  const value={schemaVersion:1,kind:'Stage1VerificationInputs',capturedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),nodeVersion:process.version,platform:process.platform,fingerprint,files};
  await writeFile(receiptPath,JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify({captured:true,fingerprint,fileCount:files.length}));
}else{
  const saved=JSON.parse(await readFile(receiptPath,'utf8'));
  if(saved.fingerprint!==fingerprint)throw new Error('Runtime verification inputs changed. Reconcile checks before claiming current evidence.');
  console.log(JSON.stringify({matches:true,fingerprint,fileCount:files.length,nodeVersion:process.version}));
}
