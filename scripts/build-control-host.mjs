import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'win32') throw new Error('The native Control Host is built on Windows.');
const compiler = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
if (!existsSync(compiler)) throw new Error('The Windows .NET Framework C# compiler is required.');
const out = resolve(process.argv[2] || join(root, '.deszo/build/control-host'));
mkdirSync(out, { recursive: true });
const files = ['NativeWindows.cs', 'ControlService.cs', 'InteractiveLauncher.cs', 'ConsentBroker.cs', 'BoundedCommand.cs', 'SourceMetadata.cs'];
const references = ['System.ServiceProcess.dll', 'System.Web.Extensions.dll', 'System.Management.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Security.dll'];
const result = spawnSync(compiler, ['/nologo', '/platform:x64', '/optimize+', '/target:winexe', `/out:${join(out, 'deszo-control.exe')}`,
  ...references.map(r => `/reference:${r}`), ...files.map(f => join(root, 'runtime/host/native', f))], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
if (result.status !== 0) throw new Error(`Control Host compilation failed:\n${result.stdout}${result.stderr}`);
writeFileSync(join(out, 'deszo-control.exe.config'), '<?xml version="1.0"?><configuration><startup useLegacyV2RuntimeActivationPolicy="true"><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>');
process.stdout.write(`${join(out, 'deszo-control.exe')}\n`);
