// Parse dependencies as data inside the protected host; never load candidate modules or its build plugins as LocalService.
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalHash, sha256 } from '../core/canonical.mjs';
import { HostError } from './hostError.mjs';

const refuse = message => { throw new HostError(403,'source_provenance_refused',message); };
const normalized = path => path.split(sep).join('/');
const pathKey=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
export const SOURCE_INVENTORY_PATH = '.deszo-source-inventory.json';
function plain(root,path) {
  const name=relative(root,path);
  if(isAbsolute(name)||name==='..'||name.startsWith(`..${sep}`))refuse('An authority dependency escaped its source root.');
  if(!existsSync(path)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||pathKey(realpathSync(path))!==pathKey(path))refuse('A source/dependency file is missing or traverses a reparse point.');
  return name;
}
export async function sourceInventory(sourceRoot,gitTool,readGit=null) {
  const root=resolve(sourceRoot);
  if(!gitTool||!isAbsolute(gitTool.path)||sha256(readFileSync(gitTool.path))!==gitTool.sha256)refuse('The independently installed Git tool identity is required.');
  const git=args=>execFileSync(gitTool.path,['--no-pager','-c',`safe.directory=${root.replace(/\\/g,'/')}`,'-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','core.untrackedCache=false','-C',root,...args],{
    encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024,
    env:{SystemRoot:process.env.SystemRoot||process.env.WINDIR||'',PATH:dirname(gitTool.path),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0'},
  });
  const metadata=readGit?await readGit(root):{sourceCommit:git(['rev-parse','--verify','HEAD']).trim(),names:git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean),commonDirectory:git(['rev-parse','--git-common-dir']).trim(),gitTool};
  if(canonicalHash(metadata.gitTool)!==canonicalHash(gitTool))refuse('The native metadata reader used another tool identity.');
  const sourceCommit=metadata.sourceCommit;if(typeof sourceCommit!=='string'||!/^[a-f0-9]{40,64}$/.test(sourceCommit))refuse('The actual source commit is not established.');
  if(!Array.isArray(metadata.names)||metadata.names.some(name=>typeof name!=='string'||!name||name.includes('\0')))refuse('The native source inventory is malformed.');
  const names=[...new Set(metadata.names)].sort();
  if(names.length>50000)refuse('The captured source inventory exceeds its file bound.');
  // Automatic dotenv/npm configuration is an additional build input; silently omitting it would invent provenance.
  for(const name of ['.env','.env.local','.env.production','.env.production.local','.npmrc'])if(existsSync(join(root,name))&&!names.includes(name))refuse(`Uncaptured build configuration: ${name}.`);
  const files=names.map(name=>{
    const path=resolve(root,name), rel=relative(root,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))refuse('The Git inventory escaped its root.');
    if(!existsSync(path))return{path:normalized(rel),absent:true};
    plain(root,path);return{path:normalized(rel),sha256:sha256(readFileSync(path))};
  });
  const commonDirectory=resolve(root,metadata.commonDirectory);
  return{root,sourceCommit,projectId:canonicalHash({gitCommonDirectory:pathKey(realpathSync(commonDirectory))}),files,sourceDigest:canonicalHash(files),gitTool:{path:gitTool.path,sha256:gitTool.sha256},metadataProcess:metadata.readerProcess??null};
}

export function authorityImportClosure(sourceRoot,entries) {
  const root=resolve(sourceRoot),seen=new Map(),pending=entries.map(name=>resolve(root,name)),edges=[];
  while(pending.length) {
    const path=pending.pop();if(seen.has(path))continue;
    if(seen.size>=4000)refuse('The authority import graph exceeds its bound.');
    const name=normalized(plain(root,path)),bytes=readFileSync(path);seen.set(path,{path:name,sha256:sha256(bytes)});
    if(/\.json$/i.test(path))continue;
    if(bytes.length>8*1024*1024)refuse('An authority source file exceeds its parser bound.');
    const ast=ts.createSourceFile(path,bytes.toString('utf8'),ts.ScriptTarget.Latest,true),requirements=new Set(['require']);
    if(ast.parseDiagnostics.length)refuse(`Cannot parse authority imports in ${name}.`);
    const include=specifier=>{
      if(typeof specifier!=='string')refuse(`Unresolved dynamic authority import in ${name}.`);
      if(specifier.startsWith('node:'))return;
      if(specifier.startsWith('#'))refuse(`Unresolved package import alias in ${name}.`);
      if(!specifier.startsWith('.')){edges.push({from:name,package:specifier});return;}
      const base=resolve(dirname(path),specifier),candidates=[base,`${base}.mjs`,`${base}.js`,`${base}.cjs`,`${base}.ts`,`${base}.tsx`,join(base,'index.mjs'),join(base,'index.js'),join(base,'index.ts')].filter(file=>existsSync(file)&&lstatSync(file).isFile());
      if(!candidates.length)refuse(`Unresolved authority import ${specifier} in ${name}.`);
      for(const target of candidates){plain(root,target);edges.push({from:name,to:normalized(relative(root,target))});pending.push(target);}
    };
    const visit=node=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)include(ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier.text:null);
      if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isCallExpression(node.initializer)&&ts.isIdentifier(node.initializer.expression)&&node.initializer.expression.text==='createRequire')requirements.add(node.name.text);
      if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&requirements.has(node.expression.text))))include(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])?node.arguments[0].text:null);
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const files=[...seen.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);edges.sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;});
  return{files,edges,digest:canonicalHash({files,edges})};
}
