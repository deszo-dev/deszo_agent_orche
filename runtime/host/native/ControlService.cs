using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Deszo.ControlHost {
    internal sealed class PeerConnection : IDisposable {
        internal string Id=Guid.NewGuid().ToString();
        internal NamedPipeServerStream Pipe;
        internal StreamWriter Writer;
        internal Dictionary<string,object> Peer;
        private readonly object gate=new object();
        internal void Send(object value){lock(gate){Writer.WriteLine(Wire.Json(value));Writer.Flush();}}
        public void Dispose(){try{Pipe.Dispose();}catch{}}
    }
    internal sealed class ControlService : ServiceBase {
        private sealed class ObservedLaunch { internal IntPtr Handle;internal Dictionary<string,object> Identity;internal uint? ExitCode; }
        private readonly string root;
        private readonly Dictionary<string,object> config;
        private readonly object gate=new object(), backendGate=new object(), journalGate=new object();
        private readonly Dictionary<string,PeerConnection> connections=new Dictionary<string,PeerConnection>();
        private readonly Dictionary<string,OwnedJob> jobs=new Dictionary<string,OwnedJob>();
        private readonly Dictionary<string,long> domainEpochs=new Dictionary<string,long>();
        private readonly Dictionary<string,int> inFlightLaunches=new Dictionary<string,int>();
        private readonly Dictionary<string,TaskCompletionSource<Dictionary<string,object>>> launcherReplies=new Dictionary<string,TaskCompletionSource<Dictionary<string,object>>>();
        private PeerConnection launcher;
        private Process backend;
        private StreamWriter backendInput;
        private bool stopping;
        private NamedPipeServerStream listening;
        private OwnedJob backendJob;
        private Dictionary<string,object> workerIdentity;
        private readonly Dictionary<int,ObservedLaunch> observedLaunches=new Dictionary<int,ObservedLaunch>();
        [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr CreateNamedPipeW(string name,uint access,uint mode,uint instances,uint output,uint input,uint timeout,ref WindowsNative.SecurityAttributes attributes);

        internal ControlService(string installRoot){root=installRoot;config=Wire.Parse(File.ReadAllText(Path.Combine(root,"installation.json")));ServiceName=Wire.Text(config,"serviceName");CanStop=true;CanShutdown=true;AutoLog=false;}
        internal void ConsoleStart(){OnStart(new string[0]);}
        internal void ConsoleStop(){OnStop();}
        protected override void OnStart(string[] args){
            // The installation, not the replaceable candidate, selects all authority executables and state paths.
            string owner=WindowsIdentity.GetCurrent().User.Value;
            if(owner!="S-1-5-19")throw new UnauthorizedAccessException("The control service must run as LocalService.");
            string sid=Wire.Text(config,"serviceSid");bool found=false;
            foreach(IdentityReference group in WindowsIdentity.GetCurrent().Groups)if(group.Value==sid)found=true;
            if(!found)throw new UnauthorizedAccessException("The dedicated service SID is missing from the process token.");
            WindowsNative.ProtectSelf(sid);
            VerifyInstallation();
            string state=Wire.Text(config,"stateRoot");Directory.CreateDirectory(state);
            backend=new Process();backend.StartInfo=new ProcessStartInfo(Path.Combine(root,"node.exe"),"--disable-warning=ExperimentalWarning "+Wire.Quote(Path.Combine(root,"service-runtime.mjs"))+" --state "+Wire.Quote(state)){
                UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root};
            backend.StartInfo.EnvironmentVariables.Clear();
            backend.StartInfo.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            backend.StartInfo.EnvironmentVariables["PATH"]=Environment.GetFolderPath(Environment.SpecialFolder.System);
            backend.EnableRaisingEvents=true;backend.Exited+=delegate { if(!stopping){Log("backend.exited",new {code=backend.ExitCode});StopOwned();Environment.Exit(71);} };
            backend.Start();WindowsNative.ProtectProcess(backend.Handle,sid);backendInput=backend.StandardInput;backendInput.AutoFlush=true;
            backendJob=new OwnedJob("authority-backend",int.MaxValue);backendJob.Assign(WindowsNative.Inspect(backend.Id));
            Backend(new {kind="initialize",installation=config,service=WindowsNative.Inspect(Process.GetCurrentProcess().Id)});
            new Thread(ReadBackend){IsBackground=true}.Start();
            new Thread(delegate(){string line;while((line=backend.StandardError.ReadLine())!=null)Log("backend.error",new {message=line.Substring(0,Math.Min(4096,line.Length))});}){IsBackground=true}.Start();
            // Reserve the first instance before SCM reports the service started.
            listening=CreatePipe(true);
            new Thread(Accept){IsBackground=true}.Start();Log("service.started",new {pid=Process.GetCurrentProcess().Id,serviceSid=sid});
        }
        private void VerifyInstallation(){
            var files=Wire.Map(config,"files");
            foreach(var entry in files){string path=Path.GetFullPath(Path.Combine(root,entry.Key));if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||Wire.Digest(path)!=Convert.ToString(entry.Value))throw new UnauthorizedAccessException("Installed artifact mismatch: "+entry.Key);}
            if(config.ContainsKey("tools")){var git=Wire.Map(Wire.Map(config,"tools"),"git");string path=Path.GetFullPath(Wire.Text(git,"path")),programFiles=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);if(!path.StartsWith(programFiles+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||Wire.Digest(path)!=Wire.Text(git,"sha256"))throw new UnauthorizedAccessException("The pinned source metadata tool identity differs.");}
            foreach(string path in new string[]{root,Wire.Text(config,"stateRoot")}){
                var acl=Directory.GetAccessControl(path);var rules=acl.GetAccessRules(true,true,typeof(SecurityIdentifier));
                foreach(FileSystemAccessRule rule in rules){if(rule.AccessControlType!=AccessControlType.Allow)continue;string sid=rule.IdentityReference.Value;
                    if(sid=="S-1-5-18"||sid=="S-1-5-32-544"||sid==Wire.Text(config,"serviceSid"))continue;
                    if((rule.FileSystemRights&(FileSystemRights.Write|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles))!=0)throw new UnauthorizedAccessException("Untrusted write access to "+path);
                }
            }
        }
        private NamedPipeServerStream CreatePipe(bool first){
            // Exclude FILE_CREATE_PIPE_INSTANCE (0x4). GENERIC_WRITE would accidentally grant it.
            string sddl="D:P(A;;GA;;;SY)(A;;GA;;;"+Wire.Text(config,"serviceSid")+")(A;;RC;;;OW)(A;;0x0012019B;;;"+Wire.Text(config,"userSid")+")";
            IntPtr descriptor;int size;WindowsNative.Check(WindowsNative.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out descriptor,out size));
            try{var attrs=new WindowsNative.SecurityAttributes{length=Marshal.SizeOf(typeof(WindowsNative.SecurityAttributes)),descriptor=descriptor,inherit=false};
                IntPtr handle=CreateNamedPipeW("\\\\.\\pipe\\"+Wire.Text(config,"pipeName"),0x40000003u|(first?0x00080000u:0u),8,255,65536,65536,0,ref attrs);
                if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
                return new NamedPipeServerStream(PipeDirection.InOut,true,false,new SafePipeHandle(handle,true));
            }finally{WindowsNative.LocalFree(descriptor);}
        }
        private void Accept(){
            while(!stopping){
                var pipe=listening;
                try{pipe.WaitForConnection();}
                catch(IOException error){
                    // A client that connected and closed before the accept ("The pipe is being closed", ERROR_NO_DATA) is not a
                    // service failure. It is routine during a restart: a client probes the pipe while SCM still reports START_PENDING.
                    if(stopping)return;
                    Log("pipe.client_dropped",new {message=error.Message});
                    try{pipe.Dispose();listening=CreatePipe(false);}
                    catch(Exception failure){Log("pipe.failure",new {message=failure.Message});StopOwned();Environment.Exit(72);}
                    continue;
                }
                catch(Exception error){if(!stopping){Log("pipe.failure",new {message=error.Message});StopOwned();Environment.Exit(72);}return;}
                try{listening=CreatePipe(false);}
                catch(Exception error){if(!stopping){Log("pipe.failure",new {message=error.Message});StopOwned();Environment.Exit(72);}return;}
                ThreadPool.QueueUserWorkItem(delegate{Serve(pipe);});
            }
        }
        private Dictionary<string,object> VerifyPeer(NamedPipeServerStream pipe){
            Dictionary<string,object> peer=null;pipe.RunAsClient(delegate{peer=WindowsNative.PipePeer(pipe.SafePipeHandle.DangerousGetHandle());});
            if(Wire.Text(peer,"userSid")!=Wire.Text(config,"userSid"))throw new UnauthorizedAccessException("Wrong desktop user.");
            string image=Wire.Text(peer,"imagePath");
            if(!String.Equals(image,Path.Combine(root,"deszo-control.exe"),StringComparison.OrdinalIgnoreCase)||Wire.Text(peer,"imageSha256")!=Wire.Text(Wire.Map(config,"files"),"deszo-control.exe"))throw new UnauthorizedAccessException("A protected native client is required.");
            // The helper supplies no claimed parent identity: read its actual parent independently.
            Dictionary<string,object> parent=null;string[] args=null,parentArgs=null;
            pipe.RunAsClient(delegate{args=WindowsNative.CommandArguments(Wire.Number(peer,"pid"));
                if(args.Length>1&&args[1]=="client"){parent=WindowsNative.Inspect(Wire.Number(peer,"parentPid"));parentArgs=WindowsNative.CommandArguments(Wire.Number(peer,"parentPid"));}
                else{parent=WindowsNative.InspectIdentity(Wire.Number(peer,"parentPid"));parentArgs=new string[0];}});
            peer["nativeMode"]=args.Length>1?args[1]:"";peer["parentArguments"]=parentArgs;
            if(Int64.Parse(Wire.Text(parent,"creationTime"))>Int64.Parse(Wire.Text(peer,"creationTime")))throw new UnauthorizedAccessException("The parent PID was reused after client creation.");
            peer["parent"]=parent;peer["verifiedByService"]=true;
            return peer;
        }
        private void Serve(NamedPipeServerStream pipe){
            var connection=new PeerConnection{Pipe=pipe};
            try{
                connection.Peer=VerifyPeer(pipe);connection.Writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true};
                lock(gate)connections.Add(connection.Id,connection);
                Backend(new {kind="connect",connectionId=connection.Id,peer=connection.Peer});
                using(var reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true)){
                    string line;while(!stopping&&(line=Wire.ReadLine(reader))!=null){var message=Wire.Parse(line);string method=Wire.Text(message,"method");
                        if(method=="launcher.connect"){
                            var p=Wire.Map(message,"params");if(Wire.Text(p,"installationId")!=Wire.Text(config,"installationId"))throw new UnauthorizedAccessException("Wrong installation.");
                            // A launcher is the protected native executable itself, never an arbitrary Node parent.
                            string mode=Wire.Text(connection.Peer,"nativeMode");
                            if((mode!="launcher"&&mode!="launcher-agent")||Wire.Flag(connection.Peer,"administratorMember")||Wire.Text(connection.Peer,"integritySid")!="S-1-16-8192")throw new UnauthorizedAccessException("A medium non-administrator launcher is required.");
                            lock(gate){if(launcher!=null)throw new UnauthorizedAccessException("A launcher is already connected.");launcher=connection;}
                            connection.Send(new {id=message["id"],result=new {connected=true,servicePid=Process.GetCurrentProcess().Id}});continue;
                        }
                        if(method=="launcher.reply"){
                            if(connection!=launcher)throw new UnauthorizedAccessException("Not the launcher.");var p=Wire.Map(message,"params");TaskCompletionSource<Dictionary<string,object>> pending=null;
                            lock(gate){string id=Wire.Text(p,"requestId");if(id!=null&&launcherReplies.TryGetValue(id,out pending))launcherReplies.Remove(id);}
                            if(pending!=null)pending.TrySetResult(p);continue;
                        }
                        // No client field can replace the verified peer or select an internal native operation.
                        Backend(new {kind="request",connectionId=connection.Id,message=message});
                    }
                }
            }catch(Exception error){Log("client.refused",new {message=error.Message});try{connection.Send(Wire.Error(null,error));}catch{}}
            finally{lock(gate){connections.Remove(connection.Id);if(launcher==connection)launcher=null;}Backend(new {kind="disconnect",connectionId=connection.Id});connection.Dispose();}
        }
        private void Backend(object message){lock(backendGate){if(!stopping&&backendInput!=null)backendInput.WriteLine(Wire.Json(message));}}
        private void ReadBackend(){
            try{string line;while(!stopping&&(line=Wire.ReadLine(backend.StandardOutput))!=null){var message=Wire.Parse(line);
                    if(message.ContainsKey("native")){var command=Wire.Map(message,"native");if(Wire.Text(command,"method")=="launch"){var args=Wire.Map(command,"params");args["serviceEpoch"]=CaptureDomainEpoch(Wire.Text(args,"domain"));}ThreadPool.QueueUserWorkItem(delegate{object result;try{result=new {id=command["id"],result=ExecuteNative(command)};}catch(Exception error){result=Wire.Error(command["id"],error);}Backend(new {kind="nativeResult",message=result});});continue;}
                    string id=Wire.Text(message,"connectionId");PeerConnection connection;lock(gate){connections.TryGetValue(id??"",out connection);}if(connection!=null)try{connection.Send(message["message"]);}catch{}
                }}catch(Exception error){Log("backend.protocol_failed",new {message=error.Message});if(!stopping){StopOwned();Environment.Exit(73);}}
        }
        private Dictionary<string,object> LauncherCall(string action,object args){
            var pending=new TaskCompletionSource<Dictionary<string,object>>();string id=Guid.NewGuid().ToString();PeerConnection selected;
            lock(gate){selected=launcher;if(selected==null)throw new InvalidOperationException("The interactive launcher is unavailable.");launcherReplies.Add(id,pending);}
            try{selected.Send(new { @event="launcher.command",requestId=id,action=action,args=args });
                if(!pending.Task.Wait(15000))throw new System.TimeoutException("The launcher outcome is unknown; reconciliation is required.");
                var reply=pending.Task.Result;if(reply.ContainsKey("error"))throw new InvalidOperationException(Wire.Text(Wire.Map(reply,"error"),"message"));return Wire.Map(reply,"result");
            }finally{lock(gate)launcherReplies.Remove(id);}
        }
        private object ExecuteNative(Dictionary<string,object> command){
            string method=Wire.Text(command,"method");var p=Wire.Map(command,"params");
            if(method=="inspect"){Dictionary<string,object> result=null;PeerConnection selected;lock(gate)selected=launcher;
                if(selected==null)return WindowsNative.Inspect(Wire.Number(p,"pid"));selected.Pipe.RunAsClient(delegate{result=WindowsNative.Inspect(Wire.Number(p,"pid"));});return result;}
            if(method=="health")return new {pid=Process.GetCurrentProcess().Id,serviceSid=Wire.Text(config,"serviceSid"),launcherConnected=launcher!=null,protectedService=true};
            if(method=="launcherIdentity"){
                PeerConnection selected;lock(gate)selected=launcher;if(selected==null)throw new InvalidOperationException("No authenticated launcher.");
                var identity=selected.Peer;return new {pid=identity["pid"],creationTime=identity["creationTime"],imageSha256=identity["imageSha256"],userSid=identity["userSid"],sessionId=identity["sessionId"]};
            }
            if(method=="isRunning"){
                return new {running=ProcessRunning(Wire.Map(p,"process"))};
            }
            // The bootstrap diagnostic is fixed installed code and requires an elevated operator in the backend.
            // It cannot select a command, policy, profile, file destination or authorize autonomous work.
            if(method=="probeLaunch"){
                string testId=Wire.Text(p,"testId");Guid parsed;if(!Guid.TryParse(testId,out parsed))throw new ArgumentException("A diagnostic UUID is required.");
                string kind=Wire.Text(p,"kind");if(kind!="tree"&&kind!="pending"&&kind!="leak"&&kind!="nested"&&kind!="stop-fence")throw new ArgumentException("Unsupported diagnostic.");
                string domain="probe:"+testId;var plan=new Dictionary<string,object>{{"domain",domain},{"remainingMs",Math.Max(500,Math.Min(10000,Wire.Number(p,"durationMs")))},{"executable",Path.Combine(root,"deszo-control.exe")},{"arguments",new string[]{"probe-tree"}},{"cwd",root}};
                if(kind=="tree")return ExecuteNative(new Dictionary<string,object>{{"method","launch"},{"params",plan}});
                if(kind=="nested"){plan["arguments"]=new string[]{"probe-nested"};return ExecuteNative(new Dictionary<string,object>{{"method","launch"},{"params",plan}});}
                if(kind=="stop-fence"){
                    plan["probePrepareDelayMs"]=1000;Exception failure=null;object result=null;var done=new ManualResetEvent(false);
                    new Thread(delegate(){try{result=ExecuteNative(new Dictionary<string,object>{{"method","launch"},{"params",plan}});}catch(Exception error){failure=error;}finally{done.Set();}}){IsBackground=true}.Start();
                    ulong deadline=WindowsNative.GetTickCount64()+3000;bool pending=false;while(WindowsNative.GetTickCount64()<deadline){lock(gate){int count;pending=inFlightLaunches.TryGetValue(domain,out count)&&count>0;}if(pending)break;Thread.Sleep(10);}if(!pending)throw new System.TimeoutException("The launch did not enter preparation.");
                    object stopped=StopDomain(domain);if(!done.WaitOne(5000)||failure==null||result!=null||!failure.Data.Contains("preparedProcess"))throw new InvalidOperationException("Stop did not refuse the pending native launch.");
                    return new {refused=true,reason=failure.Message,process=failure.Data["preparedProcess"],termination=stopped};
                }
                var prepared=LauncherCall("prepare",plan);
                if(kind=="pending")return new {process=prepared,domain=domain,resumed=false};
                using(var job=new OwnedJob(domain,5000)){IntPtr duplicate=WindowsNative.DuplicateLocal(job.Handle);string refusal=null;
                    try{try{job.Assign(prepared);}catch(UnauthorizedAccessException error){refusal=error.Message;}}finally{WindowsNative.CloseHandle(duplicate);try{LauncherCall("cancel",new {process=prepared});}catch{}}
                    if(refusal==null)throw new UnauthorizedAccessException("Leaked Job handle was not rejected.");return new {refused=true,reason=refusal,process=prepared};}
            }
            if(method=="probeInspect")return LauncherCall("probeInspect",p);
            if(method=="probeSecurity")return LauncherCall("probeSecurity",new {});
            if(method=="workerStart"){var identity=LauncherCall("workerStart",new {});
                if(Wire.Flag(identity,"administratorMember")||Wire.Text(identity,"integritySid")!="S-1-16-8192"||Wire.Text(identity,"imageSha256")!=Wire.Text(Wire.Map(config,"files"),"node.exe"))throw new UnauthorizedAccessException("Invalid worker token or image.");
                lock(gate)workerIdentity=identity;return identity;}
            if(method=="workerIdentity"){lock(gate){if(launcher==null||workerIdentity==null||Wire.Number(workerIdentity,"parentPid")!=Wire.Number(launcher.Peer,"pid"))return new {available=false};return new {available=true,process=workerIdentity};}}
            if(method=="sealBuild"){
                string buildRoot=Path.GetFullPath(Wire.Text(config,"buildRoot")),path=Path.GetFullPath(Wire.Text(p,"path"));
                if(!path.StartsWith(buildRoot+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("Build seal path is outside the installed root.");
                SealTree(path);return new {immutable=true,path=path,serviceSid=Wire.Text(config,"serviceSid"),candidateAccess="read_execute"};
            }
            if(method=="stopDomain")return StopDomain(Wire.Text(p,"domain"));
            if(method=="terminateRuntime"){
                string domain=Wire.Text(p,"domain");var expected=Wire.Map(p,"process");int pid=Wire.Number(expected,"pid");
                Dictionary<string,object> actual=null;PeerConnection selected;lock(gate)selected=launcher;
                if(selected==null)throw new UnauthorizedAccessException("The verified desktop launcher is unavailable for runtime inspection.");
                selected.Pipe.RunAsClient(delegate{actual=WindowsNative.Inspect(pid);});WindowsNative.Match(expected,actual);
                if(Wire.Text(actual,"imageSha256")!=Wire.Text(Wire.Map(config,"files"),"node.exe"))throw new UnauthorizedAccessException("The diagnostic target is not the pinned runtime.");
                lock(gate){OwnedJob job;if(!jobs.TryGetValue(domain,out job)||!job.Contains(pid))throw new UnauthorizedAccessException("The runtime is outside its owned diagnostic domain.");}
                return LauncherCall("stop",new {process=actual});
            }
            if(method=="domainHistory")return DomainHistory(Wire.Text(p,"domain"));
            if(method=="processExit"){
                var expected=Wire.Map(p,"process");lock(gate){ObservedLaunch observed;if(!observedLaunches.TryGetValue(Wire.Number(expected,"pid"),out observed))throw new UnauthorizedAccessException("No observed launch owns this PID.");WindowsNative.Match(expected,observed.Identity);
                    if(observed.ExitCode.HasValue)return new {exited=true,exitCode=observed.ExitCode.Value};
                    uint status=WindowsNative.WaitForSingleObject(observed.Handle,0);if(status==258)return new {exited=false};if(status!=0)throw new Win32Exception(Marshal.GetLastWin32Error());uint code;WindowsNative.Check(WindowsNative.GetExitCodeProcess(observed.Handle,out code));observed.ExitCode=code;WindowsNative.CloseHandle(observed.Handle);observed.Handle=IntPtr.Zero;return new {exited=true,exitCode=code};}
            }
            if(method=="contains"){lock(gate){foreach(var item in jobs)if(DomainMatches(item.Key,Wire.Text(p,"domain"))&&item.Value.Contains(Wire.Number(p,"pid")))return new {contained=true};return new {contained=false};}}
            if(method=="runtimeContext"){lock(gate){foreach(var item in jobs)if(!item.Key.StartsWith("probe:",StringComparison.Ordinal)&&item.Value.Contains(Wire.Number(p,"pid")))return new {requiresBinding=true,policyId=AuthorityDomain(item.Key)};return new {requiresBinding=false};}}
            if(method=="launch"){
                string domain=Wire.Text(p,"domain");int duration=Wire.Number(p,"remainingMs");if(String.IsNullOrEmpty(domain)||duration<1)throw new UnauthorizedAccessException("Launch authority is missing.");
                DateTime? expiry=null;
                if(!domain.StartsWith("probe:",StringComparison.Ordinal)){
                    if(!p.ContainsKey("deadlineUptimeMs")||!p.ContainsKey("expiresAt"))throw new UnauthorizedAccessException("Native absolute authority deadlines are required.");
                    long remaining=Convert.ToInt64(p["deadlineUptimeMs"])-(long)WindowsNative.GetTickCount64();expiry=DateTime.Parse(Wire.Text(p,"expiresAt"),System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.AdjustToUniversal|System.Globalization.DateTimeStyles.AssumeUniversal);
                    duration=(int)Math.Max(0,Math.Min((long)duration,Math.Min(remaining,(long)(expiry.Value-DateTime.UtcNow).TotalMilliseconds)));if(duration<1)throw new UnauthorizedAccessException("Authority expired before native launch admission.");
                }
                ulong started=WindowsNative.GetTickCount64();string authorityDomain=AuthorityDomain(domain);long epoch=p.ContainsKey("serviceEpoch")?Convert.ToInt64(p["serviceEpoch"]):CaptureDomainEpoch(domain);lock(gate){if(stopping||domainEpochs[authorityDomain]!=epoch)throw new UnauthorizedAccessException("Stop fenced the queued launch.");int active;inFlightLaunches.TryGetValue(domain,out active);inFlightLaunches[domain]=active+1;}
                Dictionary<string,object> prepared=null;OwnedJob job;
                try{RecordAdmission(domain,null);prepared=LauncherCall("prepare",p);int remaining=duration-(int)Math.Min((ulong)Int32.MaxValue,WindowsNative.GetTickCount64()-started);if(remaining<1)throw new UnauthorizedAccessException("Authority expired during launch preparation.");
                    lock(gate){if(stopping||domainEpochs[authorityDomain]!=epoch)throw new UnauthorizedAccessException("Stop fenced this pending launch.");if(observedLaunches.Count>=1024)throw new InvalidOperationException("Native launch observation capacity is exhausted.");if(!jobs.TryGetValue(domain,out job)){job=new OwnedJob(domain,remaining,0,expiry);jobs.Add(domain,job);}job.Assign(prepared);
                        int pid=Wire.Number(prepared,"pid");ObservedLaunch old;if(observedLaunches.TryGetValue(pid,out old)&&old.Handle!=IntPtr.Zero)WindowsNative.CloseHandle(old.Handle);
                        IntPtr process=WindowsNative.OpenProcess(WindowsNative.Query|0x100000,false,pid);if(process==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());observedLaunches[pid]=new ObservedLaunch{Handle=process,Identity=prepared};}RecordAdmission(domain,prepared);
                    var resumed=LauncherCall("resume",new {process=prepared});Log("launch.admitted",new {domain=domain,process=prepared});return resumed;
                }catch(Exception error){lock(gate){if(jobs.TryGetValue(domain,out job))job.Stop();}if(prepared!=null){error.Data["preparedProcess"]=prepared;try{LauncherCall("cancel",new {process=prepared});}catch{}}throw;}
                finally{lock(gate){inFlightLaunches[domain]--;Monitor.PulseAll(gate);}}
            }
            if(method=="stopProcess")return StopProcessDomain(Wire.Text(p,"domain"),Wire.Map(p,"process"),Wire.Flag(p,"graceful"));
            if(method=="uiEvidence")return LauncherCall("uiEvidence",p);
            if(method=="desktopStatus")return LauncherCall("desktopStatus",p);
            if(method=="uiFocus"){
                string domain=Wire.Text(p,"domain");var expected=Wire.Map(p,"process");WindowsNative.Match(expected,WindowsNative.InspectIdentity(Wire.Number(expected,"pid")));
                lock(gate){OwnedJob job;if(String.IsNullOrEmpty(domain)||!jobs.TryGetValue(domain,out job)||!job.Contains(Wire.Number(expected,"pid")))throw new UnauthorizedAccessException("Native UI focus requires a live application in its service-owned domain.");}
                return LauncherCall("uiFocus",p);
            }
            if(method=="openConsent")return LauncherCall("openConsent",new {});
            if(method=="profileQuiescent")return LauncherCall("profileQuiescent",p);
            if(method=="sourceMetadata")return LauncherCall("sourceMetadata",p);
            throw new UnauthorizedAccessException("Unsupported native operation.");
        }
        // Stops the owned domain behind a process: the whole Job, every descendant it holds, and confirms the Job is empty.
        // The service terminates through its own outer Job handle, so the stop does not depend on the interactive launcher.
        // A process whose identity matches but which is outside the domain is refused. A reused or vanished PID is never
        // terminated; the domain itself is the ownership proof.
        private object StopProcessDomain(string domain,Dictionary<string,object> expected,bool graceful){
            if(String.IsNullOrEmpty(domain))throw new UnauthorizedAccessException("A stop needs its owned domain.");
            int pid=Wire.Number(expected,"pid");bool matches=false;
            try{WindowsNative.Match(expected,WindowsNative.InspectIdentity(pid));matches=ProcessRunning(expected);}
            catch(UnauthorizedAccessException){matches=false;}
            catch(Win32Exception error){if(error.NativeErrorCode!=87&&error.NativeErrorCode!=1168)throw;}
            lock(gate){
                OwnedJob job;
                if(!jobs.TryGetValue(domain,out job)){
                    if(matches)throw new UnauthorizedAccessException("Refusing to stop an unrelated process.");
                }
                else if(matches&&!job.Contains(pid))throw new UnauthorizedAccessException("Refusing to stop an unrelated process.");
            }
            object cooperative=null;
            if(graceful&&matches){
                object request;try{request=LauncherCall("prepareClose",new {process=expected});}catch(Exception error){request=new {requested=false,reason=error.Message};}
                ulong end=WindowsNative.GetTickCount64()+5000;while(ProcessRunning(expected)&&WindowsNative.GetTickCount64()<end)Thread.Sleep(25);
                cooperative=new {request=request,exitedBeforeDomainStop=!ProcessRunning(expected)};
            }
            var result=StopDomain(domain);lock(gate){ObservedLaunch observed;if(observedLaunches.TryGetValue(pid,out observed)){if(observed.Handle!=IntPtr.Zero)WindowsNative.CloseHandle(observed.Handle);observedLaunches.Remove(pid);}}
            if(cooperative==null)return result;var receipt=Wire.Parse(Wire.Json(result));receipt["cooperativeClose"]=cooperative;return receipt;
        }
        private bool ProcessRunning(Dictionary<string,object> expected){
            bool running=false;Action inspect=delegate{
                IntPtr handle=WindowsNative.OpenProcess(WindowsNative.Query|0x100000,false,Wire.Number(expected,"pid"));
                if(handle==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==87||error==1168)return;throw new Win32Exception(error);}
                try{uint state=WindowsNative.WaitForSingleObject(handle,0);if(state==0)return;if(state!=258)throw new Win32Exception(Marshal.GetLastWin32Error());
                    var actual=WindowsNative.InspectIdentity(Wire.Number(expected,"pid"));bool sameBirth=Wire.Text(expected,"creationTime")==Wire.Text(actual,"creationTime");
                    if(sameBirth&&Wire.Text(expected,"imageSha256")!=Wire.Text(actual,"imageSha256"))throw new UnauthorizedAccessException("A live process has uncertain executable identity.");running=sameBirth;
                }finally{WindowsNative.CloseHandle(handle);}
            };
            PeerConnection selected;lock(gate)selected=launcher;
            // Only a temporary minimal process handle is opened under the verified desktop token. No Job handle
            // crosses the service boundary, and a missing/denied observation never means successful termination.
            if(selected==null)inspect();else selected.Pipe.RunAsClient(delegate{inspect();});return running;
        }
        private object StopDomain(string domain){
            if(String.IsNullOrEmpty(domain))throw new UnauthorizedAccessException("A stop needs its owned domain.");
            lock(gate){string authorityDomain=AuthorityDomain(domain);long epoch;domainEpochs.TryGetValue(authorityDomain,out epoch);domainEpochs[authorityDomain]=epoch+1;
                foreach(string key in new List<string>(jobs.Keys))if(DomainMatches(key,domain)){var job=jobs[key];job.Stop();job.ConfirmEmpty();job.Dispose();jobs.Remove(key);}
                ulong end=WindowsNative.GetTickCount64()+8000;for(;;){bool pending=false;foreach(var item in inFlightLaunches)if(DomainMatches(item.Key,domain)&&item.Value>0){pending=true;break;}if(!pending)break;if(WindowsNative.GetTickCount64()>=end)throw new System.TimeoutException("Pending launch cancellation is unconfirmed.");Monitor.Wait(gate,25);}
                return new {stopped=true,terminationConfirmed=true,domainEmpty=true,domain=domain,epoch=domainEpochs[authorityDomain]};}
        }
        private static string AuthorityDomain(string domain){int work=domain.IndexOf(":work:",StringComparison.Ordinal);return work<0?domain:domain.Substring(0,work);}
        private static bool DomainMatches(string candidate,string domain){return candidate==domain||candidate.StartsWith(domain+":work:",StringComparison.Ordinal);}
        private long CaptureDomainEpoch(string domain){if(String.IsNullOrEmpty(domain))throw new UnauthorizedAccessException("A launch needs its domain.");domain=AuthorityDomain(domain);lock(gate){long epoch;if(!domainEpochs.TryGetValue(domain,out epoch)){if(domainEpochs.Count>=1024)throw new InvalidOperationException("Domain history capacity exhausted.");domainEpochs.Add(domain,0);}return epoch;}}
        private void RecordAdmission(string domain,Dictionary<string,object> process){
            byte[] bytes=Encoding.UTF8.GetBytes(Wire.Json(new {schemaVersion=1,domain=domain,process=process,servicePid=Process.GetCurrentProcess().Id,at=DateTime.UtcNow.ToString("o"),ownership=process==null?"pending-before-create":"service-only-outer-job-before-resume"})+"\n");
            string path=Path.Combine(Wire.Text(config,"stateRoot"),"native-admissions.jsonl");lock(journalGate)using(var file=new FileStream(path,FileMode.Append,FileAccess.Write,FileShare.Read,4096,FileOptions.WriteThrough)){file.Write(bytes,0,bytes.Length);file.Flush(true);}
        }
        private object DomainHistory(string domain){
            if(String.IsNullOrEmpty(domain))throw new UnauthorizedAccessException("A domain is required.");string path=Path.Combine(Wire.Text(config,"stateRoot"),"native-admissions.jsonl");var records=new List<object>();
            lock(journalGate){if(!File.Exists(path))return new {recorded=true,records=records};if(new FileInfo(path).Length>64*1024*1024)throw new InvalidDataException("Native admission journal requires archival verification.");
                foreach(string line in File.ReadLines(path)){if(line.Length>Wire.Limit)throw new InvalidDataException("Native admission frame exceeds its bound.");var item=Wire.Parse(line);if(DomainMatches(Wire.Text(item,"domain"),domain)){if(records.Count>=1024)throw new InvalidDataException("Native admission scope exceeds its bound.");records.Add(item);}}}
            return new {recorded=true,records=records};
        }
        private void StopOwned(){lock(gate){foreach(var job in jobs.Values){job.Stop();job.Dispose();}jobs.Clear();}}
        private void SealTree(string path){
            var attributes=File.GetAttributes(path);if((attributes&FileAttributes.ReparsePoint)!=0)throw new UnauthorizedAccessException("Sealed builds cannot contain reparse points.");
            bool directory=(attributes&FileAttributes.Directory)!=0;
            string flags=directory?"OICI":"",sddl="D:P(A;"+flags+";FA;;;SY)(A;"+flags+";FA;;;BA)(A;"+flags+";FA;;;"+Wire.Text(config,"serviceSid")+")(A;"+flags+";FRFX;;;"+Wire.Text(config,"userSid")+")(A;"+flags+";RC;;;OW)";
            // This operation sets only the DACL. Marking every descriptor section as modified asks .NET to write
            // an audit ACL too, which incorrectly requires SeSecurityPrivilege from LocalService.
            if(directory){var acl=new DirectorySecurity();acl.SetSecurityDescriptorSddlForm(sddl,AccessControlSections.Access);Directory.SetAccessControl(path,acl);foreach(string child in Directory.GetFileSystemEntries(path))SealTree(child);}
            else{var acl=new FileSecurity();acl.SetSecurityDescriptorSddlForm(sddl,AccessControlSections.Access);File.SetAccessControl(path,acl);}
        }
        private void Log(string kind,object value){try{string path=Path.Combine(Wire.Text(config,"stateRoot"),"native-service.jsonl");lock(backendGate)File.AppendAllText(path,Wire.Json(new {time=DateTime.UtcNow.ToString("o"),kind=kind,evidence=value})+"\n");}catch{}}
        protected override void OnShutdown(){OnStop();}
        protected override void OnStop(){if(stopping)return;stopping=true;try{if(listening!=null)listening.Dispose();}catch{}StopOwned();lock(gate){foreach(var c in connections.Values)c.Dispose();}if(backendJob!=null)backendJob.Dispose();Log("service.stopped",new {pid=Process.GetCurrentProcess().Id});}
    }

    internal static class ControlProgram {
        internal static readonly string Root=Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        [STAThread] private static int Main(string[] args){
            try{
                if(args.Length==0)throw new ArgumentException("Expected service, client, inspect, launcher, broker or platform-status.");
                if(args[0]=="metadata")return SourceMetadata.Run();
                if(args[0]=="service"){ServiceBase.Run(new ControlService(Root));return 0;}
                if(args[0]=="inspect"){Console.WriteLine(Wire.Json(WindowsNative.Inspect(Int32.Parse(args[1]))));return 0;}
                if(args[0]=="platform-status"){Console.WriteLine(Wire.Json(new {desktopAvailable=WindowsNative.DesktopAvailable(),authenticator=HelloAuthenticator.Availability(),process=WindowsNative.Inspect(Process.GetCurrentProcess().Id)}));return 0;}
                if(args[0]=="probe-leaf"){Thread.Sleep(60000);return 0;}
                if(args[0]=="probe-nested"){using(var child=Process.Start(new ProcessStartInfo(Path.Combine(Root,"deszo-control.exe"),"probe-leaf"){UseShellExecute=false,CreateNoWindow=true})){using(var inner=new OwnedJob("probe-nested-inner",60000)){inner.Assign(WindowsNative.Inspect(child.Id));Thread.Sleep(60000);}}return 0;}
                if(args[0]=="probe-tree"){using(var child=Process.Start(new ProcessStartInfo(Path.Combine(Root,"deszo-control.exe"),"probe-leaf"){UseShellExecute=false,CreateNoWindow=true})){Thread.Sleep(60000);}return 0;}
                if(args[0]=="command")return BoundedCommand.Run();
                if(args[0]=="client")return NativeClient.Proxy();
                if(args[0]=="launcher"){if(Wire.Flag(WindowsNative.Inspect(Process.GetCurrentProcess().Id),"administratorMember"))return WindowsNative.RunRestrictedLauncher();return InteractiveLauncher.Run();}
                if(args[0]=="launcher-agent"){var identity=WindowsNative.Inspect(Process.GetCurrentProcess().Id);if(Wire.Flag(identity,"administratorMember")||Wire.Text(identity,"integritySid")!="S-1-16-8192")throw new UnauthorizedAccessException("Restricted launcher token required.");return InteractiveLauncher.Run();}
                if(args[0]=="broker")return ConsentBroker.Run();
                throw new ArgumentException("Unknown control-host command.");
            }catch(Exception error){Console.Error.WriteLine(Array.IndexOf(args,"--diagnostic")>=0?error.ToString():error.Message);return 1;}
        }
    }
    internal static class NativeClient {
        [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus{internal uint type,state,accepted,exitCode,specificExit,checkpoint,hint,pid,flags;}
        [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr OpenSCManagerW(string machine,string database,uint access);
        [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr OpenServiceW(IntPtr manager,string name,uint access);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool QueryServiceStatusEx(IntPtr service,int level,ref ServiceStatus status,int size,out int needed);
        [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
        internal static NamedPipeClientStream Connect(){
            var config=Wire.Parse(File.ReadAllText(Path.Combine(ControlProgram.Root,"installation.json")));
            var pipe=new NamedPipeClientStream(".",Wire.Text(config,"pipeName"),PipeAccessRights.ReadWrite,PipeOptions.Asynchronous,TokenImpersonationLevel.Impersonation,HandleInheritability.None);
            try{pipe.Connect(5000);int pid;WindowsNative.Check(WindowsNative.GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid));
                IntPtr manager=OpenSCManagerW(null,null,1);if(manager==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
                try{IntPtr service=OpenServiceW(manager,Wire.Text(config,"serviceName"),4);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
                    try{var status=new ServiceStatus();int needed;WindowsNative.Check(QueryServiceStatusEx(service,0,ref status,Marshal.SizeOf(typeof(ServiceStatus)),out needed));
                        if(status.state!=4||status.pid!=(uint)pid)throw new UnauthorizedAccessException("The pipe is not owned by the SCM service process.");
                    }finally{CloseServiceHandle(service);}
                }finally{CloseServiceHandle(manager);}
                return pipe;
            }catch{pipe.Dispose();throw;}
        }
        internal static int Proxy(){using(var pipe=Connect()){
                var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true};var reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true);
                int outstanding=0;Console.WriteLine(Wire.Json(new {@event="native_connected"}));
                var output=new Thread(new ThreadStart(delegate{try{string line;while((line=Wire.ReadLine(reader))!=null){Console.WriteLine(line);var packet=Wire.Parse(line);if(packet.ContainsKey("id"))Interlocked.Decrement(ref outstanding);}}finally{Environment.Exit(0);}})){IsBackground=true};output.Start();
                string input;while((input=Wire.ReadLine(Console.In))!=null){var packet=Wire.Parse(input);if(packet.ContainsKey("id"))Interlocked.Increment(ref outstanding);writer.WriteLine(input);}
                var deadline=DateTime.UtcNow.AddSeconds(15);while(Interlocked.CompareExchange(ref outstanding,0,0)>0&&DateTime.UtcNow<deadline)Thread.Sleep(25);return outstanding>0?2:0;
            }}
    }
}
