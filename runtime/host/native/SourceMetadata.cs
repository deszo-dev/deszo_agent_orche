// Fixed read-only Git metadata runs as the restricted desktop user, never as LocalService. Candidate modules,
// Git hooks/fsmonitor and inherited user configuration are not executable authority inputs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace Deszo.ControlHost {
    internal static class SourceMetadata {
        private static string Capture(ProcessStartInfo start,bool contain,int timeout,int limit){
            start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
            start.StandardOutputEncoding=Encoding.UTF8;start.StandardErrorEncoding=Encoding.UTF8;
            using(var job=contain?new OwnedJob("source-metadata",timeout):null)using(var child=new Process()){
                child.StartInfo=start;child.Start();
                var stdout=new StringBuilder();var stderr=new StringBuilder();var gate=new object();bool truncated=false;
                var outEnd=new ManualResetEvent(false);var errEnd=new ManualResetEvent(false);
                Action<TextReader,StringBuilder,ManualResetEvent> read=delegate(TextReader reader,StringBuilder target,ManualResetEvent done){try{char[] buffer=new char[4096];int count;while((count=reader.Read(buffer,0,buffer.Length))>0)lock(gate){int room=limit-target.Length;if(room>0)target.Append(buffer,0,Math.Min(room,count));if(count>room)truncated=true;}}catch{lock(gate)truncated=true;}finally{done.Set();}};
                var outReader=child.StandardOutput;var errReader=child.StandardError;
                new Thread(delegate(){read(outReader,stdout,outEnd);}){IsBackground=true}.Start();new Thread(delegate(){read(errReader,stderr,errEnd);}){IsBackground=true}.Start();
                try{
                    if(job!=null){job.Assign(WindowsNative.Inspect(child.Id));child.StandardInput.WriteLine("contained");child.StandardInput.Flush();}child.StandardInput.Close();
                    if(!child.WaitForExit(timeout)){if(job!=null)job.Stop();else child.Kill();child.WaitForExit(2000);throw new TimeoutException("Source metadata deadline elapsed.");}
                    if(!outEnd.WaitOne(2000)||!errEnd.WaitOne(2000)||truncated)throw new InvalidDataException("Source metadata capture is incomplete.");
                    if(child.ExitCode!=0)throw new InvalidDataException("Read-only source metadata failed: "+stderr.ToString().Substring(0,Math.Min(2000,stderr.Length)));
                    return stdout.ToString();
                }catch{try{if(job!=null)job.Stop();else if(!child.HasExited)child.Kill();}catch{}throw;}
            }
        }
        internal static object ReadInRestrictedSession(Dictionary<string,object> config,Dictionary<string,object> p){
            var identity=WindowsNative.Inspect(Process.GetCurrentProcess().Id);
            if(Wire.Flag(identity,"administratorMember")||Wire.Text(identity,"integritySid")!="S-1-16-8192")throw new UnauthorizedAccessException("Metadata requires the restricted launcher token.");
            string source=Path.GetFullPath(Wire.Text(p,"sourceRoot"));if(source.StartsWith("\\\\",StringComparison.Ordinal)||!Directory.Exists(source))throw new UnauthorizedAccessException("A local existing source directory is required.");
            var start=new ProcessStartInfo(Path.Combine(ControlProgram.Root,"deszo-control.exe"),"metadata"){WorkingDirectory=ControlProgram.Root};start.EnvironmentVariables.Clear();
            start.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);start.EnvironmentVariables["DESZO_METADATA_ROOT"]=source;
            return Wire.Parse(Capture(start,true,18000,262144));
        }
        internal static int Run(){
            var self=WindowsNative.Inspect(Process.GetCurrentProcess().Id);
            if(Wire.Flag(self,"administratorMember")||Wire.Text(self,"integritySid")!="S-1-16-8192")throw new UnauthorizedAccessException("Metadata cannot run with administrator authority.");
            int contained=0;new Thread(delegate(){Thread.Sleep(10000);if(Interlocked.CompareExchange(ref contained,0,0)==0)Environment.Exit(140);}){IsBackground=true}.Start();
            if(Console.ReadLine()!="contained")throw new UnauthorizedAccessException("Metadata awaits native containment.");Interlocked.Exchange(ref contained,1);
            string source=Environment.GetEnvironmentVariable("DESZO_METADATA_ROOT");Environment.SetEnvironmentVariable("DESZO_METADATA_ROOT",null);
            if(String.IsNullOrEmpty(source)||source.StartsWith("\\\\",StringComparison.Ordinal)||!Directory.Exists(source))throw new UnauthorizedAccessException("A local source is required.");
            var config=Wire.Parse(File.ReadAllText(Path.Combine(ControlProgram.Root,"installation.json")));var tool=Wire.Map(Wire.Map(config,"tools"),"git");string executable=Wire.Text(tool,"path");
            if(Wire.Digest(executable)!=Wire.Text(tool,"sha256"))throw new UnauthorizedAccessException("The source metadata tool differs from the installation.");
            Func<string[],string> git=delegate(string[] args){var all=new List<string>{"--no-pager","-c","safe.directory="+source.Replace('\\','/'),"-c","core.fsmonitor=false","-c","core.hooksPath=NUL","-c","core.untrackedCache=false","-C",source};all.AddRange(args);
                var start=new ProcessStartInfo(executable,Wire.Arguments(all.ToArray())){WorkingDirectory=ControlProgram.Root};start.EnvironmentVariables.Clear();
                start.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);start.EnvironmentVariables["PATH"]=Path.GetDirectoryName(executable)+";"+Environment.GetFolderPath(Environment.SpecialFolder.System);
                start.EnvironmentVariables["GIT_CONFIG_NOSYSTEM"]="1";start.EnvironmentVariables["GIT_CONFIG_GLOBAL"]="NUL";start.EnvironmentVariables["GIT_OPTIONAL_LOCKS"]="0";
                return Capture(start,false,4000,131072);
            };
            string head=git(new string[]{"rev-parse","--verify","HEAD"}).Trim(),names=git(new string[]{"ls-files","-z","--cached","--others","--exclude-standard"}),common=git(new string[]{"rev-parse","--git-common-dir"}).Trim();
            Console.WriteLine(Wire.Json(new {sourceCommit=head,names=names.Split(new char[]{'\0'},StringSplitOptions.RemoveEmptyEntries),commonDirectory=common,gitTool=tool,readerProcess=self}));return 0;
        }
    }
}
