// ADR-0006 native primitives. No caller-supplied PID, SID or creation timestamp is trusted.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Deszo.ControlHost {
    internal static class Wire {
        internal const int Limit = 1024 * 1024;
        internal static Dictionary<string, object> Parse(string value) {
            if (value == null || value.Length > Limit) throw new InvalidDataException("Invalid message size.");
            return new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 48 }.Deserialize<Dictionary<string, object>>(value);
        }
        internal static string Json(object value) { return new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 48 }.Serialize(value); }
        internal static string Text(Dictionary<string, object> value, string key) { object v; return value.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null; }
        internal static Dictionary<string, object> Map(Dictionary<string, object> value, string key) { object v; return value.TryGetValue(key, out v) && v is Dictionary<string, object> ? (Dictionary<string, object>)v : new Dictionary<string, object>(); }
        internal static int Number(Dictionary<string, object> value, string key) { object v; return value.TryGetValue(key, out v) ? Convert.ToInt32(v) : 0; }
        internal static bool Flag(Dictionary<string, object> value, string key) { object v; return value.TryGetValue(key, out v) && v is bool && (bool)v; }
        internal static string ReadLine(TextReader reader) {
            var b = new StringBuilder(); int c;
            while ((c = reader.Read()) != -1) { if (c == '\n') return b.ToString().TrimEnd('\r'); if (b.Length >= Limit) throw new InvalidDataException("Message too large."); b.Append((char)c); }
            return b.Length == 0 ? null : b.ToString();
        }
        internal static string Digest(string path) { using (var input = File.OpenRead(path)) using (var hash = SHA256.Create()) return Hex(hash.ComputeHash(input)); }
        internal static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
        internal static string Quote(string arg) {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var b = new StringBuilder("\""); int slashes = 0;
            foreach (char c in arg) { if (c == '\\') { slashes++; continue; } if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); } else { b.Append('\\', slashes); b.Append(c); } slashes = 0; }
            b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
        }
        internal static string Arguments(object args) {
            var list = args as System.Collections.IEnumerable; var b = new StringBuilder();
            if (list != null) foreach (object arg in list) { if (!(arg is string)) throw new InvalidDataException("Arguments must be strings."); if (b.Length > 0) b.Append(' '); b.Append(Quote((string)arg)); }
            return b.ToString();
        }
        internal static object Error(object id, Exception error) { return new { id = id, error = new { status = error is UnauthorizedAccessException ? 403 : 409, code = "native_refused", message = error.Message } }; }
    }

    internal static class WindowsNative {
        internal const uint Query = 0x1000, Terminate = 1, SetQuota = 0x100, SuspendResume = 2;
        internal const uint Suspended = 4, UnicodeEnvironment = 0x400, NoWindow = 0x08000000;
        internal const uint KillOnClose = 0x2000;
        [StructLayout(LayoutKind.Sequential)] internal struct FileTime { internal uint low, high; internal long Value { get { return ((long)high << 32) | low; } } }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { internal IntPtr process, thread; internal int pid, tid; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo {
            internal int cb; internal string reserved, desktop, title; internal int x,y,width,height,xchars,ychars,fill,flags; internal short show,reserved2; internal IntPtr reservedPtr,input,output,error;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct StartupInfoEx { internal StartupInfo startup; internal IntPtr attributes; }
        [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { internal int length; internal IntPtr descriptor; internal bool inherit; }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { internal ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
        [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits { internal long processTime,jobTime; internal uint flags; internal UIntPtr min,max; internal uint active; internal UIntPtr affinity; internal uint priority,scheduling; }
        [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimits { internal BasicLimits basic; internal IoCounters io; internal UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
        [StructLayout(LayoutKind.Sequential)] internal struct ObjectInfo { internal uint attributes,access,handles,pointers,paged,nonPaged,reserved1,reserved2,reserved3,nameInfo,typeInfo,descriptorSize; internal long created; }
        [StructLayout(LayoutKind.Sequential)] internal struct BasicProcessInfo { internal IntPtr exitStatus,peb,affinity,priority,pid,parentPid; }
        [StructLayout(LayoutKind.Sequential)] internal struct SidAndAttributes { internal IntPtr sid; internal uint attributes; }
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr OpenThread(uint access, bool inherit, int tid);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exit, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] internal static extern bool QueryFullProcessImageNameW(IntPtr handle, int flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool ProcessIdToSessionId(int pid, out int session);
        [DllImport("advapi32.dll", SetLastError=true)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token,int informationClass,out int value,int length,out int returned);
        [DllImport("advapi32.dll",EntryPoint="GetTokenInformation",SetLastError=true)] private static extern bool TokenBuffer(IntPtr token,int kind,IntPtr value,int length,out int returned);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr value,int length);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,ref SidAndAttributes disabled,uint deleteCount,IntPtr deleted,uint restrictCount,IntPtr restricted,out IntPtr result);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool CheckTokenMembership(IntPtr token,IntPtr sid,out bool member);
        [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfo startup,out ProcessInfo info);
        [DllImport("advapi32.dll",EntryPoint="CreateProcessAsUserW",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool CreateProcessAsUserExW(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfoEx startup,out ProcessInfo info);
        [DllImport("advapi32.dll",SetLastError=true)] private static extern bool SetKernelObjectSecurity(IntPtr handle,uint information,IntPtr descriptor);
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] internal static extern ulong GetTickCount64();
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
        internal static IntPtr DuplicateLocal(IntPtr handle){IntPtr duplicate;Check(DuplicateHandle(GetCurrentProcess(),handle,GetCurrentProcess(),out duplicate,0,false,2));return duplicate;}
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out int pid);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out int pid);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool GetNamedPipeClientSessionId(IntPtr pipe, out int session);
        [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] internal static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, int size);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetExitCodeProcess(IntPtr process,out uint code);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr result,int size,out int returned);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] internal static extern bool CreateProcessW(string app, StringBuilder command, ref SecurityAttributes processAttrs, ref SecurityAttributes threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll",EntryPoint="CreateProcessW",SetLastError=true,CharSet=CharSet.Unicode)] private static extern bool CreateProcessExW(string app,StringBuilder command,ref SecurityAttributes processAttrs,ref SecurityAttributes threadAttrs,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfoEx startup,out ProcessInfo info);
        [DllImport("kernel32.dll",SetLastError=true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
        [DllImport("kernel32.dll",SetLastError=true)] private static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
        [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out int length);
        [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr ptr);
        [DllImport("shell32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr CommandLineToArgvW(string line,out int count);
        [DllImport("ntdll.dll")] internal static extern int NtQueryObject(IntPtr handle, int type, ref ObjectInfo info, int size, out int length);
        [DllImport("ntdll.dll")] internal static extern int NtQueryInformationProcess(IntPtr process, int type, ref BasicProcessInfo info, int size, out int length);
        [DllImport("user32.dll", SetLastError=true)] internal static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError=true)] internal static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] internal static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder result, uint length, out uint needed);

        internal static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        internal static bool QueryJobAccounting(IntPtr job,IntPtr data,out int returned){return QueryInformationJobObject(job,1,data,48,out returned);}
        internal static Dictionary<string, object> Inspect(int pid) { return Inspect(pid, true); }
        internal static Dictionary<string, object> InspectIdentity(int pid) { return Inspect(pid, false); }
        private static Dictionary<string, object> Inspect(int pid, bool inspectToken) {
            IntPtr handle = OpenProcess(Query, false, pid); if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                FileTime c,e,k,u; Check(GetProcessTimes(handle, out c,out e,out k,out u));
                var path = new StringBuilder(32768); int length = path.Capacity; Check(QueryFullProcessImageNameW(handle,0,path,ref length));
                int session; Check(ProcessIdToSessionId(pid,out session));
                var basic=new BasicProcessInfo(); int returned; int status=NtQueryInformationProcess(handle,0,ref basic,Marshal.SizeOf(typeof(BasicProcessInfo)),out returned);
                var result = new Dictionary<string,object> { {"pid",pid}, {"creationTime",c.Value.ToString()}, {"imagePath",path.ToString()}, {"imageSha256",Wire.Digest(path.ToString())}, {"sessionId",session}, {"parentPid",status==0 ? basic.parentPid.ToInt32() : 0} };
                if(inspectToken){IntPtr token;Check(OpenProcessToken(handle,10,out token));try{using(var identity=new WindowsIdentity(token)){result["userSid"]=identity.User.Value;int elevation,returnedElevation;Check(GetTokenInformation(token,20,out elevation,4,out returnedElevation));result["elevatedAdministrator"]=elevation!=0;result["administratorMember"]=AdministratorMember(token);result["integritySid"]=IntegritySid(token);}}finally{CloseHandle(token);}}
                return result;
            } finally { CloseHandle(handle); }
        }
        internal static void Match(Dictionary<string,object> expected, Dictionary<string,object> actual) {
            foreach(string key in new string[]{"pid","creationTime","imageSha256"}) if(Wire.Text(expected,key)!=Wire.Text(actual,key)) throw new UnauthorizedAccessException("Process identity mismatch: "+key);
        }
        internal static bool DesktopAvailable() {
            IntPtr desktop=OpenInputDesktop(0,false,0x0001); if(desktop==IntPtr.Zero)return false;
            try { var name=new StringBuilder(256);uint needed;return GetUserObjectInformationW(desktop,2,name,512,out needed) && name.ToString()=="Default"; } finally { CloseDesktop(desktop); }
        }
        internal static Dictionary<string,object> PipePeer(IntPtr pipe) {
            int pid, session;Check(GetNamedPipeClientProcessId(pipe,out pid));Check(GetNamedPipeClientSessionId(pipe,out session));var peer=Inspect(pid);
            if(Wire.Number(peer,"sessionId")!=session)throw new UnauthorizedAccessException("Pipe session changed.");return peer;
        }
        internal static string[] CommandArguments(int pid) {
            string line;using(var item=new ManagementObject("Win32_Process.Handle='"+pid.ToString()+"'")){item.Get();line=Convert.ToString(item["CommandLine"]);}
            if(String.IsNullOrEmpty(line))throw new UnauthorizedAccessException("Cannot independently inspect the peer command line.");
            int count;IntPtr args=CommandLineToArgvW(line,out count);if(args==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            try{var values=new string[count];for(int i=0;i<count;i++)values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,i*IntPtr.Size));return values;}finally{LocalFree(args);}
        }
        internal static void ProtectedFile(string path, string serviceSid, bool directory, bool writable) {
            // Only SYSTEM, administrators and this service SID may modify the protected authority installation.
            string inheritance=directory ? "OICI" : "";
            string sddl="O:BAG:BAD:P(A;"+inheritance+";FA;;;SY)(A;"+inheritance+";FA;;;BA)(A;"+inheritance+";"+(writable?"FA":"FRFX")+";;;"+serviceSid+")";
            if(directory){var acl=new DirectorySecurity();acl.SetSecurityDescriptorSddlForm(sddl,AccessControlSections.Access);Directory.SetAccessControl(path,acl);}else{var acl=new FileSecurity();acl.SetSecurityDescriptorSddlForm(sddl,AccessControlSections.Access);File.SetAccessControl(path,acl);}
        }
        internal static void ProtectProcess(IntPtr process,string serviceSid){
            IntPtr descriptor;int length;Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;"+serviceSid+")(A;;RC;;;OW)",1,out descriptor,out length));
            try{Check(SetKernelObjectSecurity(process,4,descriptor));}finally{LocalFree(descriptor);}
        }
        internal static void ProtectSelf(string serviceSid){ProtectProcess(GetCurrentProcess(),serviceSid);}
        private static IntPtr Sid(string value){byte[] bytes=new byte[new SecurityIdentifier(value).BinaryLength];new SecurityIdentifier(value).GetBinaryForm(bytes,0);IntPtr sid=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,sid,bytes.Length);return sid;}
        private static bool AdministratorMember(IntPtr token){IntPtr duplicate,admin=Sid("S-1-5-32-544");try{Check(DuplicateToken(token,2,out duplicate));try{bool member;Check(CheckTokenMembership(duplicate,admin,out member));return member;}finally{CloseHandle(duplicate);}}finally{Marshal.FreeHGlobal(admin);}}
        private static string IntegritySid(IntPtr token){int length;TokenBuffer(token,25,IntPtr.Zero,0,out length);IntPtr data=Marshal.AllocHGlobal(length);try{Check(TokenBuffer(token,25,data,length,out length));return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;}finally{Marshal.FreeHGlobal(data);}}
        internal static int RunRestrictedLauncher(){
            IntPtr source,restricted=IntPtr.Zero,admin=Sid("S-1-5-32-544"),medium=Sid("S-1-16-8192"),label=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)));
            Check(OpenProcessToken(GetCurrentProcess(),0x000F01FF,out source));
            try{var disabled=new SidAndAttributes{sid=admin};Check(CreateRestrictedToken(source,5,1,ref disabled,0,IntPtr.Zero,0,IntPtr.Zero,out restricted));
                // A filtered primary token must own new objects as the user, not the now deny-only admin group.
                // Its default DACL must also permit that user to inspect the tokens/pipes of its descendants.
                IntPtr user=Sid(WindowsIdentity.GetCurrent().User.Value),tokenField=Marshal.AllocHGlobal(IntPtr.Size),aclBuffer=IntPtr.Zero;
                try{Marshal.WriteIntPtr(tokenField,user);Check(SetTokenInformation(restricted,4,tokenField,IntPtr.Size));
                    var descriptor=new RawSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;"+WindowsIdentity.GetCurrent().User.Value+")");
                    byte[] acl=new byte[descriptor.DiscretionaryAcl.BinaryLength];descriptor.DiscretionaryAcl.GetBinaryForm(acl,0);aclBuffer=Marshal.AllocHGlobal(acl.Length);Marshal.Copy(acl,0,aclBuffer,acl.Length);Marshal.WriteIntPtr(tokenField,aclBuffer);Check(SetTokenInformation(restricted,6,tokenField,IntPtr.Size));
                }finally{Marshal.FreeHGlobal(user);Marshal.FreeHGlobal(tokenField);if(aclBuffer!=IntPtr.Zero)Marshal.FreeHGlobal(aclBuffer);}
                Marshal.StructureToPtr(new SidAndAttributes{sid=medium,attributes=0x20},label,false);Check(SetTokenInformation(restricted,25,label,Marshal.SizeOf(typeof(SidAndAttributes))+new SecurityIdentifier("S-1-16-8192").BinaryLength));
                if(AdministratorMember(restricted)||IntegritySid(restricted)!="S-1-16-8192")throw new UnauthorizedAccessException("Could not establish a medium non-administrator launcher token.");
                // SCM/task termination also closes the bootstrap Job and reaps this helper. The helper's own
                // children leave this infrastructure Job and enter the atomic pending/authority Jobs instead.
                using(var owner=new OwnedJob("launcher-bootstrap",Int32.MaxValue,0x1000)){
                    IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);IntPtr list=Marshal.AllocHGlobal(size),jobs=Marshal.AllocHGlobal(IntPtr.Size);bool initialized=false;
                    try{Check(InitializeProcThreadAttributeList(list,1,0,ref size));initialized=true;Marshal.WriteIntPtr(jobs,owner.Handle);Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x0002000d),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
                        var startup=new StartupInfoEx{startup=new StartupInfo{cb=Marshal.SizeOf(typeof(StartupInfoEx)),desktop="winsta0\\default"},attributes=list};ProcessInfo process;
                        string image=Path.Combine(ControlProgram.Root,"deszo-control.exe");Check(CreateProcessAsUserExW(restricted,image,new StringBuilder(Wire.Quote(image)+" launcher-agent"),IntPtr.Zero,IntPtr.Zero,false,NoWindow|0x00080000,IntPtr.Zero,ControlProgram.Root,ref startup,out process));
                        try{WaitForSingleObject(process.process,UInt32.MaxValue);return 0;}finally{CloseHandle(process.thread);CloseHandle(process.process);}
                    }finally{if(initialized)DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(jobs);Marshal.FreeHGlobal(list);}
                }
            }finally{CloseHandle(source);if(restricted!=IntPtr.Zero)CloseHandle(restricted);Marshal.FreeHGlobal(admin);Marshal.FreeHGlobal(medium);Marshal.FreeHGlobal(label);}
        }
        internal static ProcessInfo CreateSuspendedInJob(string executable,string command,string cwd,IntPtr environment,ref SecurityAttributes attrs,IntPtr job){
            IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if(size==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr list=Marshal.AllocHGlobal(size),jobs=Marshal.AllocHGlobal(IntPtr.Size);bool initialized=false;
            try{Check(InitializeProcThreadAttributeList(list,1,0,ref size));initialized=true;Marshal.WriteIntPtr(jobs,job);
                Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x0002000d),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
                var startup=new StartupInfoEx{startup=new StartupInfo{cb=Marshal.SizeOf(typeof(StartupInfoEx)),desktop="winsta0\\default"},attributes=list};ProcessInfo process;
                Check(CreateProcessExW(executable,new StringBuilder(command),ref attrs,ref attrs,false,Suspended|UnicodeEnvironment|0x00080000,environment,cwd,ref startup,out process));return process;
            }finally{if(initialized)DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(jobs);Marshal.FreeHGlobal(list);}
        }
    }

    internal sealed class OwnedJob : IDisposable {
        internal readonly IntPtr Handle;
        internal readonly string Domain;
        private readonly object gate=new object();
        private readonly System.Threading.ManualResetEvent cancel=new System.Threading.ManualResetEvent(false);
        private bool disposed, handoff;
        internal OwnedJob(string domain, int durationMs, uint extraFlags=0, DateTime? absoluteExpiry=null) {
            if(durationMs<1)throw new UnauthorizedAccessException("No remaining lifetime.");
            Domain=domain;Handle=WindowsNative.CreateJobObjectW(IntPtr.Zero,null); if(Handle==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits=new WindowsNative.ExtendedLimits();limits.basic.flags=WindowsNative.KillOnClose|extraFlags;
            try { WindowsNative.Check(WindowsNative.SetInformationJobObject(Handle,9,ref limits,Marshal.SizeOf(typeof(WindowsNative.ExtendedLimits))));
                // A dedicated native-host thread does not depend on the Node/renderer event loop or the CLR pool.
                // GetTickCount64 includes suspend time. Recheck on wake instead of extending a relative timer.
                ulong end=WindowsNative.GetTickCount64()+(ulong)durationMs;
                DateTime wallEnd=DateTime.UtcNow.AddMilliseconds(durationMs);if(absoluteExpiry.HasValue&&absoluteExpiry.Value<wallEnd)wallEnd=absoluteExpiry.Value;
                new System.Threading.Thread(delegate(){while(!cancel.WaitOne(100)){lock(gate){if(disposed||handoff)return;if(WindowsNative.GetTickCount64()>=end||DateTime.UtcNow>=wallEnd){WindowsNative.TerminateJobObject(Handle,137);return;}}}}){IsBackground=true}.Start();
            } catch { WindowsNative.CloseHandle(Handle);throw; }
        }
        internal void Assign(Dictionary<string,object> expected) {
            int pid=Wire.Number(expected,"pid");IntPtr process=WindowsNative.OpenProcess(WindowsNative.Query|WindowsNative.SetQuota|WindowsNative.Terminate,false,pid);
            if(process==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            try { lock(gate){if(disposed||handoff)throw new ObjectDisposedException("Job");WindowsNative.Match(expected,WindowsNative.InspectIdentity(pid));WindowsNative.Check(WindowsNative.AssignProcessToJobObject(Handle,process));
                var info=new WindowsNative.ObjectInfo();int returned;
                if(WindowsNative.NtQueryObject(Handle,0,ref info,Marshal.SizeOf(typeof(WindowsNative.ObjectInfo)),out returned)!=0||info.handles!=1)throw new UnauthorizedAccessException("Outer Job does not have exclusive handle ownership.");
                bool inside;WindowsNative.Check(WindowsNative.IsProcessInJob(process,Handle,out inside));if(!inside)throw new UnauthorizedAccessException("Process is outside its Job.");}
            } finally { WindowsNative.CloseHandle(process); }
        }
        internal bool Contains(int pid) {lock(gate){
            if(disposed)return false;
            // Descendants use the desktop user's default process DACL; LocalService must not interpret denied
            // OpenProcess access as absence from its outer Job. Query the owned Job's native PID list instead.
            for(int capacity=256;capacity<=65536;capacity*=2){int length=8+capacity*IntPtr.Size;IntPtr data=Marshal.AllocHGlobal(length);
                try{int returned;bool ok=WindowsNative.QueryInformationJobObject(Handle,3,data,length,out returned);int error=Marshal.GetLastWin32Error();
                    if(!ok&&error!=234)throw new Win32Exception(error);
                    int assigned=Marshal.ReadInt32(data,0),listed=Marshal.ReadInt32(data,4);
                    if(listed<0||listed>capacity||assigned<listed)throw new InvalidDataException("Invalid native Job process list.");
                    for(int i=0;i<listed;i++)if(Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt64()==pid)return true;
                    if(ok&&assigned==listed)return false;
                }finally{Marshal.FreeHGlobal(data);}
            }
            throw new InvalidDataException("Native Job membership exceeds its verified query bound.");
        }}
        internal void Stop(){lock(gate){if(!disposed)WindowsNative.Check(WindowsNative.TerminateJobObject(Handle,137));}}
        internal void ConfirmEmpty(){lock(gate){if(disposed)throw new ObjectDisposedException("Job");IntPtr data=Marshal.AllocHGlobal(48);try{ulong end=WindowsNative.GetTickCount64()+5000;do{int returned;WindowsNative.Check(QueryJob(Handle,data,out returned));if(Marshal.ReadInt32(data,40)==0)return;System.Threading.Thread.Sleep(25);}while(WindowsNative.GetTickCount64()<end);throw new TimeoutException("Native Job still has active processes.");}finally{Marshal.FreeHGlobal(data);}}}
        private static bool QueryJob(IntPtr handle,IntPtr data,out int returned){return WindowsNative.QueryJobAccounting(handle,data,out returned);}
        internal void CompleteHandoff(){lock(gate){if(disposed)throw new ObjectDisposedException("Job");var limits=new WindowsNative.ExtendedLimits();WindowsNative.Check(WindowsNative.SetInformationJobObject(Handle,9,ref limits,Marshal.SizeOf(typeof(WindowsNative.ExtendedLimits))));handoff=true;cancel.Set();}}
        public void Dispose(){lock(gate){if(disposed)return;disposed=true;cancel.Set();WindowsNative.CloseHandle(Handle);}}
    }
}
