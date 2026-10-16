// Diagnostic reproducer: records observations for each defect. It has no assertions and no pass/fail counter; verification lives in the asserting probes and runtime/tests.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalHash} from '../../../runtime/core/canonical.mjs';
import {executeBranchDelivery} from '../../../runtime/core/branchDelivery.mjs';
import {deriveSourceFacts,selectExecutionPlan,DEFAULT_DESZO_CRITICAL_AREAS} from '../../../runtime/core/taskAssessment.mjs';
import {buildContextPackage,handleContextNeededRequest,evaluateAcceptanceRecord} from '../../../runtime/core/contextPackage.mjs';

const scratch=mkdtempSync(join(tmpdir(),'deszo-adr-probes-'));
const results=[];
function runGit(args,cwd,requireSuccess=true){
 const res=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});
 if(requireSuccess && res.status!==0)throw new Error(args.join(' ')+': '+(res.stderr||res.stdout));
 return requireSuccess?res.stdout.trim():res;
}
function fixture(name){
 const root=join(scratch,name,'host');mkdirSync(root,{recursive:true});
 runGit(['init','-b','main'],root);
 runGit(['config','user.name','Review Fixture'],root);
 runGit(['config','user.email','fixture@example.com'],root);
 runGit(['config','core.autocrlf','false'],root);
 writeFileSync(join(root,'README.md'),'Fixture base\n');
 runGit(['add','README.md'],root);runGit(['commit','-m','base'],root);
 return {root,base:runGit(['rev-parse','HEAD'],root),clone:join(scratch,name,'clone')};
}
function planFor(repo,files,overrides={}){
 const manifest=files.map(f=>({path:f.path.replace(/\\/g,'/'),digest:canonicalHash(f.content)})).sort((a,b)=>a.path.localeCompare(b.path));
 return {schemaVersion:1,kind:'DeliveryPlan',deliveryPlanId:'REVIEW-'+randomUUID(),runId:randomUUID(),candidateDigest:canonicalHash(manifest),repositoryPath:repo.root,baseCommit:repo.base,targetBranchRef:'refs/heads/feature/review',branchExpectedOldValue:null,isolation:{mode:'separate_clone',cloneStrategy:'reference_dissociate'},hookPolicy:{installHooks:false,hookSource:null,hooksJournal:'none'},verificationChecks:[],commitPolicy:{authorName:'Review Fixture',authorEmail:'fixture@example.com',message:'delivery probe'},boundaryCriteria:[{id:'BR-1',description:'Deliver only the accepted candidate.'}],createdAt:new Date().toISOString(),...overrides};
}
async function probe(name,fn){try{results.push({name,...await fn()});}catch(error){results.push({name,error:error.stack||String(error)});}}
const approvedFiles=[{path:'approved.txt',content:'APPROVED\n'}];

await probe('smoke_mutation_commits_unreviewed_source',async()=>{
 const repo=fixture('smoke-mutation');
 const plan=planFor(repo,approvedFiles,{verificationChecks:[{id:'mutating-smoke',command:process.execPath,args:['-e',"require('fs').writeFileSync('approved.txt','UNREVIEWED\\n'); require('fs').writeFileSync('extra.txt','UNDECLARED\\n')"],expectedExitCode:0}]});
 const result=await executeBranchDelivery({plan,candidateFiles:approvedFiles,cloneDir:repo.clone});
 return {status:result.status,ready:result.readyForMerge,resultDigestStillEqualsApproved:result.canonicalManifestDigest===plan.candidateDigest,committed:result.verifiedCommitId?runGit(['show',result.verifiedCommitId+':approved.txt'],repo.root):null,extraCommitted:result.verifiedCommitId?runGit(['show',result.verifiedCommitId+':extra.txt'],repo.root):null};
});
await probe('candidate_path_escapes_clone',async()=>{
 const repo=fixture('path-escape');const outside=join(scratch,'path-escape','outside.txt');writeFileSync(outside,'PRESERVE');
 const files=[...approvedFiles,{path:'../outside.txt',content:'OVERWRITTEN'}];
 const plan=planFor(repo,files);
 const result=await executeBranchDelivery({plan,candidateFiles:files,cloneDir:repo.clone});
 return {status:result.status,outsideContent:readFileSync(outside,'utf8'),outsideIsBeyondClone:!outside.startsWith(repo.clone)};
});
await probe('existing_clone_directory_is_deleted',async()=>{
 const repo=fixture('directory-loss');mkdirSync(repo.clone,{recursive:true});const sentinel=join(repo.clone,'user-file.txt');writeFileSync(sentinel,'PRESERVE');
 const result=await executeBranchDelivery({plan:planFor(repo,approvedFiles),candidateFiles:approvedFiles,cloneDir:repo.clone});
 return {status:result.status,existingFilePreserved:existsSync(sentinel)};
});
await probe('configured_hook_is_not_installed_or_executed',async()=>{
 const repo=fixture('ignored-hook');const hooks=join(scratch,'ignored-hook','required-hooks');mkdirSync(hooks,{recursive:true});writeFileSync(join(hooks,'pre-commit'),'#!/bin/sh\nexit 7\n',{mode:0o755});
 const plan=planFor(repo,approvedFiles,{hookPolicy:{installHooks:true,hookSource:hooks,hooksJournal:'installed'}});
 const result=await executeBranchDelivery({plan,candidateFiles:approvedFiles,cloneDir:repo.clone});
 return {status:result.status,reportedHookExecution:result.hookExecution.status,requiredRejectingHookPresent:existsSync(join(repo.clone,'.git','hooks','pre-commit'))};
});
await probe('hook_mutation_is_not_compared_to_recorded_tree',async()=>{
 const repo=fixture('hook-tree-change');
 const hook='#!/bin/sh\nprintf "HOOK-CHANGED\\n" > approved.txt\ngit add approved.txt\n';
 const install="const fs=require('fs'); fs.writeFileSync('.git/hooks/pre-commit',"+JSON.stringify(hook)+",{mode:0o755})";
 const plan=planFor(repo,approvedFiles,{verificationChecks:[{id:'install-unexpected-hook',command:process.execPath,args:['-e',install],expectedExitCode:0}]});
 const result=await executeBranchDelivery({plan,candidateFiles:approvedFiles,cloneDir:repo.clone});
 const actualTree=result.verifiedCommitId?runGit(['rev-parse',result.verifiedCommitId+'^{tree}'],repo.root):null;
 return {status:result.status,reportedHookExecution:result.hookExecution.status,recordedTreeMatchesActual:result.treeId===actualTree,committed:result.verifiedCommitId?runGit(['show',result.verifiedCommitId+':approved.txt'],repo.root):null};
});
await probe('existing_branch_can_be_rewound_to_older_base',async()=>{
 const repo=fixture('branch-history');
 runGit(['checkout','-b','feature/existing'],repo.root);writeFileSync(join(repo.root,'existing-feature.txt'),'EXISTING FEATURE\n');runGit(['add','existing-feature.txt'],repo.root);runGit(['commit','-m','existing feature'],repo.root);
 const expectedOld=runGit(['rev-parse','HEAD'],repo.root);runGit(['checkout','main'],repo.root);
 const plan=planFor(repo,approvedFiles,{targetBranchRef:'refs/heads/feature/existing',branchExpectedOldValue:expectedOld});
 const result=await executeBranchDelivery({plan,candidateFiles:approvedFiles,cloneDir:repo.clone});
 return {status:result.status,parentMatchesExpectedOld:result.parentCommitId===expectedOld,previousHeadIsAncestor:result.verifiedCommitId?runGit(['merge-base','--is-ancestor',expectedOld,result.verifiedCommitId],repo.root,false).status===0:null,existingFeatureStillInBranch:result.verifiedCommitId?runGit(['cat-file','-e',result.verifiedCommitId+':existing-feature.txt'],repo.root,false).status===0:null};
});
const baseAcceptance={schemaVersion:1,kind:'AcceptanceRecord',recordId:'ACC-REVIEW',deliveryBoundary:'candidate',subjectId:'SUBJ-REVIEW',candidateDigest:'c'.repeat(64),accepter:{role:'analyst',provider:'codex',model:'gpt-6.1-sol',effort:'max',contextId:'fresh',independent:false},criteria:[],overallStatus:'accepted',unresolvedLimitations:[],evaluatedAt:new Date().toISOString()};
await probe('empty_acceptance_opens_gate',async()=>evaluateAcceptanceRecord(baseAcceptance));
await probe('satisfied_without_evidence_opens_gate',async()=>evaluateAcceptanceRecord({...baseAcceptance,criteria:[{criterionId:'AC-1',requirementRef:'REQ-1',status:'satisfied',reason:'Claimed satisfied',evidenceRefs:[]}]}));
const pkgInput={role:'codeReviewer',taskBinding:'TASK-1',subjectDigest:'a'.repeat(64),declaredScope:['src/main.js']};
const firstPackage=buildContextPackage({...pkgInput,stepInstanceId:'attempt-A'});
const secondPackage=buildContextPackage({...pkgInput,stepInstanceId:'attempt-B'});
const request={paths:['src/helper.js'],reason:'Required dependency',blocksDecision:'approval'};
const available=new Map([['src/helper.js','export const helper = 1;']]);
await probe('package_expansion_hash_depends_on_attempt_identity',async()=>{
 const a=handleContextNeededRequest({request,contextPackage:firstPackage,availableArtifacts:available});
 const b=handleContextNeededRequest({request,contextPackage:secondPackage,availableArtifacts:available});
 return {originalSemanticHashesEqual:firstPackage.semanticFingerprint===secondPackage.semanticFingerprint,expandedSemanticHashesEqual:a.widenedPackage.semanticFingerprint===b.widenedPackage.semanticFingerprint};
});
await probe('partially_missing_context_request_is_treated_as_resumable',async()=>{
 const result=handleContextNeededRequest({request:{...request,paths:['src/helper.js','src/missing.js']},contextPackage:firstPackage,availableArtifacts:available});
 return {resumed:result.resumed,reportedMissing:result.missing??result.diagnostics??null,containsRequiredMissingFile:result.widenedPackage?.sourceAndChanges.some(f=>f.path==='src/missing.js')??false};
});
function assessment(){return {schemaVersion:1,kind:'TaskAssessment',assessmentId:'ASSESS-REVIEW',assessmentRunId:randomUUID(),businessRequestId:'BUSINESS-1',authorRole:'analyst',sourceSnapshotHash:'a'.repeat(64),intendedOutcome:'Add a local setting',constraints:[],requirements:[{id:'REQ-1',title:'Setting',acceptanceCriteria:[{id:'AC-1',description:'Setting works',requiredEvidence:'Unit test',evidenceProducer:'test-author'}]}],scope:{affectedComponents:['src/local.js']},sourceDerivedFacts:{criticalPaths:[],publicContracts:[],dependencyFanOut:1},assessmentAxes:{scopeCoupling:'local',technicalDifficulty:'low',failureImpact:'limited',uncertainty:'low',verifiability:'clear'},grounds:{references:['src/local.js'],assumptions:[],confidence:'Recorded',unresolvedQuestions:[]},planningAdvice:{recommendedStages:[]},createdAt:new Date().toISOString()};}
const facts=deriveSourceFacts(['src/local.js'],{criticalAreas:DEFAULT_DESZO_CRITICAL_AREAS});
const confirmed={confirmed:true,confirmedBy:'developer',reason:'Unverified caller claim'};
await probe('missing_bindings_get_invented_model_defaults',async()=>{
 const plan=selectExecutionPlan({assessment:assessment(),sourceFacts:facts,reviewerConfirmation:confirmed});
 return {models:Object.values(plan.roleBindings).map(b=>b.provider+':'+b.model+':'+b.effort)};
});
await probe('equivalent_but_distinct_reviewer_objects_bypass_separation',async()=>{
 const shared={role:'reviewer',provider:'claude',model:'claude-opus-5-5',effort:'medium'};
 const bindings={analyst:{role:'analyst',provider:'codex',model:'gpt-6.1-sol',effort:'max'},developer:{role:'developer',provider:'claude',model:'claude-haiku-5-5',effort:'xhigh'},testAuthor:{role:'testAuthor',provider:'claude',model:'claude-haiku-5-5',effort:'xhigh'},codeReviewer:{...shared},testReviewer:{...shared}};
 const plan=selectExecutionPlan({assessment:assessment(),sourceFacts:facts,roleBindings:bindings,reviewerConfirmation:confirmed});
 return {accepted:true,codeRole:plan.roleBindings.codeReviewer.role,testRole:plan.roleBindings.testReviewer.role};
});
const validBindings={analyst:{role:'analyst',provider:'codex',model:'gpt-6.1-sol',effort:'max'},developer:{role:'developer',provider:'claude',model:'claude-haiku-5-5',effort:'xhigh'},codeReviewer:{role:'codeReviewer',provider:'codex',model:'gpt-6.1-sol',effort:'high'},testReviewer:{role:'testReviewer',provider:'claude',model:'claude-haiku-5-5',effort:'high'}};
await probe('plan_fingerprint_ignores_requirement_and_budget_changes',async()=>{
 const a=assessment();const first=selectExecutionPlan({assessment:a,sourceFacts:facts,roleBindings:validBindings,reviewerConfirmation:confirmed,aggregateBounds:{maxAttempts:5,maxElapsedSeconds:60}});
 const changed={...a,intendedOutcome:'Different task',requirements:[{id:'REQ-OTHER',title:'Different obligation',acceptanceCriteria:[]}]};
 const second=selectExecutionPlan({assessment:changed,sourceFacts:facts,roleBindings:validBindings,reviewerConfirmation:confirmed,aggregateBounds:{maxAttempts:100,maxElapsedSeconds:3600}});
 return {sameFingerprint:first.planFingerprint===second.planFingerprint,firstBounds:first.aggregateBounds.maxAttempts,secondBounds:second.aggregateBounds.maxAttempts};
});
await probe('high_uncertainty_unverified_task_still_gets_compact_plan',async()=>{
 const a=assessment();a.assessmentAxes.uncertainty='high';a.assessmentAxes.verifiability='unverified';a.grounds.unresolvedQuestions=['Unknown acceptance meaning'];
 const plan=selectExecutionPlan({assessment:a,sourceFacts:facts,roleBindings:validBindings,reviewerConfirmation:confirmed});
 return {classification:plan.classification.winningClassification,stages:plan.selectedStages,hasIndependentAccepter:Object.keys(plan.roleBindings).some(k=>/accepter/i.test(k))};
});
const report={scratch,source:'runtime modules from this checkout',results};
if (process.argv[2]) writeFileSync(process.argv[2],JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));



