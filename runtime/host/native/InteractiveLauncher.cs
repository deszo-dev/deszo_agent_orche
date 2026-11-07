using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Deszo.ControlHost {
    internal sealed class PendingLaunch : IDisposable {
        internal WindowsNative.ProcessInfo Handles;
        internal Dictionary<string,object> Identity;
        internal Timer Timeout;
        internal bool Resumed;
        internal OwnedJob PendingJob;
        public void Dispose(){if(Timeout!=null)Timeout.Dispose();if(!Resumed&&Handles.process!=IntPtr.Zero)WindowsNative.TerminateProcess(Handles.process,138);if(Handles.thread!=IntPtr.Zero)WindowsNative.CloseHandle(Handles.thread);if(Handles.process!=IntPtr.Zero)WindowsNative.CloseHandle(Handles.process);if(PendingJob!=null){PendingJob.Dispose();PendingJob=null;}Handles.process=IntPtr.Zero;Handles.thread=IntPtr.Zero;}
    }
    internal static class InteractiveLauncher {
        private static readonly object gate=new object();
        private static readonly Dictionary<int,PendingLaunch> pending=new Dictionary<int,PendingLaunch>();
        private static Dictionary<string,object> config;
        private static System.Diagnostics.Process worker;
        private static string workerFailure;
        private delegate bool EnumCallback(IntPtr window,IntPtr arg);
        [StructLayout(LayoutKind.Sequential)] private struct Rect{internal int left,top,right,bottom;}
        [StructLayout(LayoutKind.Sequential)] private struct LastInput{internal uint size,tick;}
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback,IntPtr arg);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out int pid);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr window,StringBuilder title,int count);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window,out Rect rect);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window,int command);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll",SetLastError=true)] private static extern bool PostMessageW(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput input);
        [DllImport("user32.dll",SetLastError=true)] private static extern bool SystemParametersInfoW(uint action,uint parameter,out uint value,uint flags);

        internal static int Run(){
            config=Wire.Parse(File.ReadAllText(Path.Combine(ControlProgram.Root,"installation.json")));
            // This agent has no authority keys, policy database or unrestricted first-party runtime credential.
            while(true){try{using(var pipe=NativeClient.Connect())using(var reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true))using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true}){
                        writer.WriteLine(Wire.Json(new {id="launcher-connect",method="launcher.connect",@params=new {installationId=Wire.Text(config,"installationId")}}));
                        string line;while((line=Wire.ReadLine(reader))!=null){var packet=Wire.Parse(line);if(Wire.Text(packet,"event")!="launcher.command")continue;
                            object response;try{response=new {requestId=packet["requestId"],result=Execute(Wire.Text(packet,"action"),Wire.Map(packet,"args"))};}catch(Exception error){response=new {requestId=packet["requestId"],error=new {message=error.Message}};}
                            writer.WriteLine(Wire.Json(new {method="launcher.reply",@params=response}));
                        }
                    }}catch(Exception error){Console.Error.WriteLine("Launcher disconnected: "+error.Message);}
                // Loss before admission/resume never leaves a suspended process behind.
                lock(gate){foreach(var launch in pending.Values)launch.Dispose();pending.Clear();}Thread.Sleep(1500);
            }
        }
        private static object Execute(string action,Dictionary<string,object> p){
            if(action=="prepare")return Prepare(p);
            if(action=="workerStart"){
                if(worker!=null&&!worker.HasExited)return WindowsNative.Inspect(worker.Id);
                if(worker!=null&&worker.HasExited){worker.Dispose();worker=null;if(!String.IsNullOrEmpty(workerFailure)){string error=workerFailure;workerFailure=null;throw new InvalidOperationException("Worker startup: "+error);}}
                var start=new System.Diagnostics.ProcessStartInfo(Path.Combine(ControlProgram.Root,"node.exe"),"--disable-warning=ExperimentalWarning "+Wire.Quote(Path.Combine(ControlProgram.Root,"worker.mjs"))){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=ControlProgram.Root,RedirectStandardError=true};
                start.EnvironmentVariables.Clear();
                foreach(string key in new string[]{"SystemRoot","WINDIR","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP","USERNAME","USERDOMAIN"}){string value=Environment.GetEnvironmentVariable(key);if(value!=null)start.EnvironmentVariables[key]=value;}
                start.EnvironmentVariables["PATH"]=ControlProgram.Root+";"+Environment.GetFolderPath(Environment.SpecialFolder.System);
                try{worker=System.Diagnostics.Process.Start(start);}catch(Exception error){throw new InvalidOperationException("Worker process creation: "+error.Message);}
                worker.ErrorDataReceived+=delegate(object source,System.Diagnostics.DataReceivedEventArgs e){if(e.Data!=null){lock(gate){workerFailure=(workerFailure??"")+e.Data+"\n";if(workerFailure.Length>4096)workerFailure=workerFailure.Substring(0,4096);}}};worker.BeginErrorReadLine();
                try{return WindowsNative.Inspect(worker.Id);}catch(Exception error){throw new InvalidOperationException("Worker identity inspection: "+error.Message);}
            }
            if(action=="resume"||action=="cancel"){
                var expected=Wire.Map(p,"process");int pid=Wire.Number(expected,"pid");lock(gate){PendingLaunch launch;if(!pending.TryGetValue(pid,out launch))throw new UnauthorizedAccessException("No pending launch.");
                    WindowsNative.Match(expected,launch.Identity);pending.Remove(pid);
                    try{if(action=="resume"){if(!WindowsNative.DesktopAvailable())throw new InvalidOperationException("Interactive desktop unavailable.");
                            // The service has confirmed its own exclusive Job ownership. Release the temporary
                            // creation Job only now; a launcher crash before this point closes it and kills the child.
                            launch.PendingJob.CompleteHandoff();launch.PendingJob.Dispose();launch.PendingJob=null;
                            if(WindowsNative.ResumeThread(launch.Handles.thread)==UInt32.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error());launch.Resumed=true;}
                        return launch.Identity;
                    }finally{launch.Dispose();}
                }
            }
            if(action=="stop"){
                var expected=Wire.Map(p,"process");WindowsNative.Match(expected,WindowsNative.Inspect(Wire.Number(expected,"pid")));
                IntPtr handle=WindowsNative.OpenProcess(WindowsNative.Query|WindowsNative.Terminate|0x100000,false,Wire.Number(expected,"pid"));if(handle==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
                try{WindowsNative.Check(WindowsNative.TerminateProcess(handle,137));if(WindowsNative.WaitForSingleObject(handle,5000)!=0)throw new TimeoutException("Termination not confirmed.");return new {terminated=true,pid=expected["pid"],creationTime=expected["creationTime"]};}finally{WindowsNative.CloseHandle(handle);}
            }
            if(action=="uiEvidence")return UiEvidence(p);
            if(action=="uiFocus")return UiFocus(p);
            if(action=="desktopStatus"){
                var input=new LastInput{size=(uint)Marshal.SizeOf(typeof(LastInput))};uint timeout;
                bool observed=GetLastInputInfo(ref input),configured=SystemParametersInfoW(0x2000,0,out timeout,0); // SPI_GETFOREGROUNDLOCKTIMEOUT, read only.
                return new {desktopAvailable=WindowsNative.DesktopAvailable(),inputObserved=observed,idleMs=observed?(object)unchecked((uint)WindowsNative.GetTickCount64()-input.tick):null,foregroundTimeoutObserved=configured,foregroundLockTimeoutMs=configured?(object)timeout:null,observedAt=DateTime.UtcNow.ToString("o")};
            }
            if(action=="prepareClose"){
                if(!WindowsNative.DesktopAvailable())return new {requested=false,reason="interactive_desktop_unavailable"};
                var expected=Wire.Map(p,"process");Dictionary<string,object> actual;IntPtr window=ApplicationWindow(expected,out actual);
                if(window==IntPtr.Zero)return new {requested=false,reason="no_visible_window_for_process"};
                int owner;GetWindowThreadProcessId(window,out owner);if(owner!=Wire.Number(actual,"pid"))throw new UnauthorizedAccessException("The selected close target was replaced.");
                return new {requested=PostMessageW(window,0x0010,IntPtr.Zero,IntPtr.Zero),pid=actual["pid"],creationTime=actual["creationTime"],window=window.ToInt64().ToString()}; // WM_CLOSE, owned application only.
            }
            if(action=="openConsent"){
                if(!WindowsNative.DesktopAvailable())throw new InvalidOperationException("Interactive desktop unavailable.");
                using(var process=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"schtasks.exe"),"/Run /TN \\DeszoControlHost\\ConsentBroker"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true})){
                    if(!process.WaitForExit(5000))throw new TimeoutException("Consent task start is unconfirmed.");if(process.ExitCode!=0)throw new InvalidOperationException("The installed consent task refused to start.");return new {requested=true};}
            }
            if(action=="profileQuiescent"){
                string path=Path.GetFullPath(Wire.Text(p,"path")),root=Path.GetFullPath(Wire.Text(config,"profileRoot"));
                if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("Profile is outside its installed root.");
                string file=Path.Combine(path,"runtime","runner.lock");if(!File.Exists(file))return new {quiescent=true,basis="no_runtime_lock"};
                var record=Wire.Parse(File.ReadAllText(file));int pid=Wire.Number(record,"pid");if(pid<1)throw new InvalidDataException("Unverifiable runtime lock.");
                IntPtr process=WindowsNative.OpenProcess(WindowsNative.Query,false,pid);
                if(process!=IntPtr.Zero){WindowsNative.CloseHandle(process);return new {quiescent=false,basis="lock_process_alive",pid=pid};}
                int error=Marshal.GetLastWin32Error();if(error!=87&&error!=1168)throw new Win32Exception(error);return new {quiescent=true,basis="lock_process_terminated",pid=pid};
            }
            if(action=="probeSecurity"){
                // A protected metadata executable must not become a candidate-controlled LocalService tool.
                var results=new Dictionary<string,object>();
                var targets=new Dictionary<string,string>{{"config",Path.Combine(ControlProgram.Root,"installation.json")},{"state",Path.Combine(Wire.Text(config,"stateRoot"),"host.sqlite")},{"launcherTask",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"Tasks","DeszoControlHost","InteractiveLauncher")},{"brokerTask",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"Tasks","DeszoControlHost","ConsentBroker")}};
                if(config.ContainsKey("tools"))targets.Add("gitTool",Wire.Text(Wire.Map(Wire.Map(config,"tools"),"git"),"path"));
                foreach(var entry in targets){
                    try{using(var file=new FileStream(entry.Value,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite)){results[entry.Key]=new {denied=false};}}
                    catch(UnauthorizedAccessException error){results[entry.Key]=new {denied=true,hresult=error.HResult};}
                    catch(Exception error){results[entry.Key]=new {denied=false,error=error.Message};}
                }
                try{using(var api=new BrokerApi()){api.Call("consent.overview",new {});results["brokerRole"]=new {denied=false};}}catch(Exception error){results["brokerRole"]=new {denied=error.Message.Contains("protected elevated broker"),reason=error.Message};}
                results["process"]=WindowsNative.Inspect(System.Diagnostics.Process.GetCurrentProcess().Id);return results;
            }
            if(action=="sourceMetadata")return SourceMetadata.ReadInRestrictedSession(config,p);
            if(action=="probeInspect"){
                var expected=Wire.Map(p,"process");Dictionary<string,object> actual;
                try{actual=WindowsNative.Inspect(Wire.Number(expected,"pid"));}catch(Win32Exception error){if(error.NativeErrorCode==87||error.NativeErrorCode==1168)return new {alive=false};throw;}
                WindowsNative.Match(expected,actual);var children=new List<object>();
                using(var search=new System.Management.ManagementObjectSearcher("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId="+Wire.Number(actual,"pid").ToString()))using(var results=search.Get())foreach(System.Management.ManagementObject child in results)using(child){var observed=WindowsNative.Inspect(Convert.ToInt32(child["ProcessId"]));if(Int64.Parse(Wire.Text(observed,"creationTime"))>=Int64.Parse(Wire.Text(actual,"creationTime")))children.Add(observed);}
                return new {alive=true,process=actual,children=children};
            }
            throw new UnauthorizedAccessException("Launcher action is not supported.");
        }
        private static object Prepare(Dictionary<string,object> p){
            if(!WindowsNative.DesktopAvailable())throw new InvalidOperationException("Interactive desktop unavailable.");
            if(p.ContainsKey("probePrepareDelayMs")){int delay=Wire.Number(p,"probePrepareDelayMs");if(!Wire.Text(p,"domain").StartsWith("probe:",StringComparison.Ordinal)||delay!=1000)throw new UnauthorizedAccessException("Only the fixed installed Stop-fence diagnostic may delay preparation.");Thread.Sleep(delay);}
            string executable=Path.GetFullPath(Wire.Text(p,"executable"));if(!File.Exists(executable))throw new FileNotFoundException("Selected executable does not exist.");
            // Authority-selected paths arrive only over the mutually verified service channel, never from a worker socket.
            string cwd=Path.GetFullPath(Wire.Text(p,"cwd")??Path.GetDirectoryName(executable));
            var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach(string key in new string[]{"SystemRoot","WINDIR","PATH","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP","USERNAME","USERDOMAIN","HOMEDRIVE","HOMEPATH","COMSPEC"}){string value=Environment.GetEnvironmentVariable(key);if(value!=null)env[key]=value;}
            foreach(var entry in Wire.Map(p,"environment")){if(entry.Key.IndexOfAny(new char[]{'=', '\0'})>=0||!(entry.Value is string)||((string)entry.Value).Contains("\0"))throw new InvalidDataException("Invalid environment.");env[entry.Key]=(string)entry.Value;}
            var block=new StringBuilder();foreach(var entry in env)block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');block.Append('\0');
            IntPtr environment=Marshal.StringToHGlobalUni(block.ToString()),descriptor=IntPtr.Zero;int length;
            string sddl="D:P(A;;GA;;;SY)(A;;GA;;;"+Wire.Text(config,"userSid")+")(A;;GA;;;"+Wire.Text(config,"serviceSid")+")";
            WindowsNative.Check(WindowsNative.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out descriptor,out length));
            try{var attrs=new WindowsNative.SecurityAttributes{length=Marshal.SizeOf(typeof(WindowsNative.SecurityAttributes)),descriptor=descriptor,inherit=false};
                string command=Wire.Quote(executable);string arguments=Wire.Arguments(p.ContainsKey("arguments")?p["arguments"]:null);if(arguments.Length>0)command+=" "+arguments;
                var creationJob=new OwnedJob("pending-launch",10000);WindowsNative.ProcessInfo info;
                try{info=WindowsNative.CreateSuspendedInJob(executable,command,cwd,environment,ref attrs,creationJob.Handle);}catch{creationJob.Dispose();throw;}
                var launch=new PendingLaunch{Handles=info,PendingJob=creationJob};try{launch.Identity=WindowsNative.Inspect(info.pid);
                    lock(gate){pending.Add(info.pid,launch);launch.Timeout=new Timer(delegate{lock(gate){if(pending.Remove(info.pid))launch.Dispose();}},null,10000,Timeout.Infinite);}
                    return launch.Identity;
                }catch{launch.Dispose();throw;}
            }finally{if(descriptor!=IntPtr.Zero)WindowsNative.LocalFree(descriptor);Marshal.FreeHGlobal(environment);}
        }
        private static IntPtr ApplicationWindow(Dictionary<string,object> expected,out Dictionary<string,object> actual){
            int pid=Wire.Number(expected,"pid");actual=WindowsNative.Inspect(pid);WindowsNative.Match(expected,actual);
            if(Wire.Text(actual,"userSid")!=Wire.Text(config,"userSid")||Wire.Number(actual,"sessionId")!=System.Diagnostics.Process.GetCurrentProcess().SessionId||Wire.Flag(actual,"administratorMember"))throw new UnauthorizedAccessException("Native UI belongs to another user/session or a privileged process.");
            IntPtr window=IntPtr.Zero;EnumWindows(delegate(IntPtr handle,IntPtr unused){int owner;GetWindowThreadProcessId(handle,out owner);if(owner==pid&&IsWindowVisible(handle)){window=handle;return false;}return true;},IntPtr.Zero);return window;
        }
        private static object UiFocus(Dictionary<string,object> p){
            if(!WindowsNative.DesktopAvailable())return new {focused=false,reason="interactive_desktop_unavailable"};
            var expected=Wire.Map(p,"process");Dictionary<string,object> actual;IntPtr window=ApplicationWindow(expected,out actual);
            if(window==IntPtr.Zero)return new {focused=false,reason="no_visible_window_for_process"};
            int owner;GetWindowThreadProcessId(window,out owner);if(owner!=Wire.Number(actual,"pid"))throw new UnauthorizedAccessException("The selected window was replaced.");
            if(IsIconic(window))ShowWindowAsync(window,9); // SW_RESTORE; never synthetic input, thread-input attachment or a security dialog.
            bool requested=GetForegroundWindow()==window||SetForegroundWindow(window);
            ulong deadline=WindowsNative.GetTickCount64()+1500;
            while(GetForegroundWindow()!=window&&WindowsNative.GetTickCount64()<deadline)Thread.Sleep(25);
            GetWindowThreadProcessId(window,out owner);bool focused=WindowsNative.DesktopAvailable()&&owner==Wire.Number(actual,"pid")&&GetForegroundWindow()==window;
            return new {focused=focused,reason=focused?null:"foreground_activation_denied",requested=requested,pid=actual["pid"],creationTime=actual["creationTime"],sessionId=actual["sessionId"],window=window.ToInt64().ToString(),runtimeGeneration=Wire.Text(p,"runtimeGeneration"),observedAt=DateTime.UtcNow.ToString("o")};
        }
        private static object UiEvidence(Dictionary<string,object> p){
            if(!WindowsNative.DesktopAvailable())return new {available=false,reason="interactive_desktop_unavailable"};
            var expected=Wire.Map(p,"process");Dictionary<string,object> actual;IntPtr window=ApplicationWindow(expected,out actual);int pid=Wire.Number(actual,"pid");
            if(window==IntPtr.Zero)return new {available=false,reason="no_visible_window_for_process"};
            Rect bounds;if(!GetWindowRect(window,out bounds)||bounds.right<=bounds.left||bounds.bottom<=bounds.top)return new {available=false,reason="invalid_window_bounds"};
            // Occluded/background captures are not positive evidence of the application under test.
            if(GetForegroundWindow()!=window)return new {available=false,reason="application_not_foreground"};
            var title=new StringBuilder(512);GetWindowTextW(window,title,title.Capacity);
            using(var bitmap=new Bitmap(bounds.right-bounds.left,bounds.bottom-bounds.top))using(var graphics=Graphics.FromImage(bitmap))using(var output=new MemoryStream()){
                graphics.CopyFromScreen(bounds.left,bounds.top,0,0,bitmap.Size);bitmap.Save(output,ImageFormat.Png);byte[] png=output.ToArray();
                int owner;GetWindowThreadProcessId(window,out owner);if(!WindowsNative.DesktopAvailable()||GetForegroundWindow()!=window||owner!=pid)return new {available=false,reason="desktop_or_window_changed_during_capture"};
                if(png.Length>600000)return new {available=false,reason="native_evidence_exceeds_transport_limit"};
                return new {available=true,pid=pid,creationTime=actual["creationTime"],sessionId=actual["sessionId"],runtimeGeneration=Wire.Text(p,"runtimeGeneration"),window=window.ToInt64().ToString(),title=title.ToString(),foreground=true,observedAt=DateTime.UtcNow.ToString("o"),pngBase64=Convert.ToBase64String(png)};
            }
        }
    }
}
