// Read-only analysis of existing PoC results. Never runs the PoC or a model.
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const directory=fileURLToPath(new URL('.',import.meta.url)),prior=fileURLToPath(new URL('../2026-10-21-antigravity-judge-e2e/',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fields=['input_tokens','output_tokens','thinking_tokens','cache_read_tokens','total_tokens'];
const snapshots=[];
for(const name of await readdir(join(prior,'traces'))){
  if(!/^turn.*-result\.json$/.test(name))continue;
  const bytes=await readFile(join(prior,'traces',name)),value=JSON.parse(bytes),native=value.parsedOutput||{};
  const usage=Object.fromEntries(fields.map(key=>[key,Number.isFinite(value.tokens?.[key])?value.tokens[key]:null]));
  snapshots.push({source:`../2026-10-21-antigravity-judge-e2e/traces/${name}`,sourceSha256:hash(bytes),nativeSessionIdentitySha256:hash(native.conversation_id||value.conversationId||''),providerNumTurns:native.num_turns??null,providerStatus:native.status??null,localCliDurationMs:value.durationMs??null,providerCumulativeDurationSeconds:native.duration_seconds??null,nativeUsage:usage,deniedActionCount:value.deniedActions?.length??null,promptBytes:null,evidenceBytes:null,providerRetries:null});
}
snapshots.sort((a,b)=>a.providerNumTurns-b.providerNumTurns);
for(let index=0;index<snapshots.length;index++){
  const current=snapshots[index],previous=snapshots[index-1];
  if(previous&&previous.nativeSessionIdentitySha256===current.nativeSessionIdentitySha256){
    current.derivedSincePreviousSnapshot={turnsCovered:current.providerNumTurns-previous.providerNumTurns,usage:Object.fromEntries(fields.map(k=>[k,current.nativeUsage[k]===null||previous.nativeUsage[k]===null?null:current.nativeUsage[k]-previous.nativeUsage[k]])),qualification:'Difference of observed cumulative counters; a gap covers multiple turns and is not an independently billed per-turn measurement.'};
  }
}
const telemetryBytes=await readFile(join(prior,'traces/exp-f-telemetry.json')),telemetry=JSON.parse(telemetryBytes);
const result={schemaVersion:1,kind:'Stage1HistoricalTelemetryAnalysis',recordedAt:new Date().toISOString(),newProviderCalls:0,
  sources:{reportedSummary:{path:'../2026-10-21-antigravity-judge-e2e/traces/exp-f-telemetry.json',sha256:hash(telemetryBytes)},scopeDocumentation:'https://antigravity.google/docs/cli/headless/'},
  historicalSummary:{claimedInvocations:telemetry.turns_executed,claimedTotalTokens:telemetry.token_accounting.total_tokens_consumed,claimedDurationSeconds:telemetry.total_duration_seconds},
  availableRawInvocationSnapshots:snapshots.length,snapshots,
  latestObservedCumulativeSessionUsage:snapshots.at(-1)?.nativeUsage,
  analysis:{usageScope:'cumulative_session',numTurnsScope:'cumulative_session',nativeDurationScope:'cumulative_session',localCliDurationScope:'one_process_wall_time',historicalAggregation:'Summing resumed cumulative usage snapshots double counts earlier session work. The raw counters increase with num_turns in the same native session; the official headless documentation identifies these metadata counters as cumulative.',thinkingTokens:'Do not add thinking_tokens again to total_tokens; the native total equals input_tokens + output_tokens in the observed records.',efficiencyCause:'Repeated session history/cumulative accounting is demonstrated. Relative effects of prompt bytes, MCP output, reasoning effort, model steps and cache behavior cannot be isolated from four saved snapshots; the two queued-turn raw results and matched before/after quota observations are absent.',comparison:'Minimal / one-detail / multiple-detail Bridge measurements are in component-performance.json. They are deterministic component measurements, not live model consumption.',billing:'No trustworthy billing attribution or before/after subscription-quota measurements. The historical hard-coded $0.00 field is not adopted.'},productionPathE2E:'BLOCKED'};
await writeFile(join(directory,'historical-telemetry-analysis.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({availableRawSnapshots:snapshots.length,reportedHistoricalTotal:result.historicalSummary.claimedTotalTokens,latestObservedCumulative:result.latestObservedCumulativeSessionUsage,newProviderCalls:0},null,2));
