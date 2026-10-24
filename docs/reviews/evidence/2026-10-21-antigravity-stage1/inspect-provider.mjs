// Explicit read-only CLI metadata/settings inspection. Does not launch a model or read authentication stores.
import { writeFile } from 'node:fs/promises';
import { AntigravityJudgeAdapter } from '../../../../runtime/core/antigravityJudgeAdapter.mjs';
const index=process.argv.indexOf('--cli'),cliPath=index<0?null:process.argv[index+1];
if(!cliPath)throw new Error('Supply --cli with the explicit installed Antigravity executable path.');
const adapter=new AntigravityJudgeAdapter({cliPath});
const capabilities=await adapter.inspectCapabilities(),authentication=await adapter.validateAuthentication();
let billing;
try{billing=await adapter.verifyBillingMode();}catch(error){billing={verified:false,code:error.code};}
const result={schemaVersion:1,kind:'Stage1ReadOnlyProviderInspection',recordedAt:new Date().toISOString(),capabilities,authentication,billing,providerInferenceCalls:0,authenticationStoresRead:false,modelLaunchAttempted:false};
await writeFile(new URL('provider-readonly-inspection.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
