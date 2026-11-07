// P6-DECISION-C isolation spike (2026-11-06). Compares what a same-user child process can reach with what an AppContainer child
// can reach, using only test-owned folders and a test-owned listener. It answers one question for the Control-Process design:
// does Windows (on this machine, without administrator rights) enforce a boundary between a Host-started process and a
// same-user child that holds the Engine's authority?
//
// Build (no admin): csc /out:<root>\shared\appcontainer-spike.exe appcontainer-spike.cs
// Run:              appcontainer-spike.exe run <root>      (root is a test-owned directory)
// Modes:            child plain|appcontainer <root> <parentPid> <parentMarkerAddress> <listenerPort>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Spike
{
    const string ContainerName = "DeszoDecisionCControlSpike";
    const int ERROR_ALREADY_EXISTS = unchecked((int)0x800700B7);
    // ProcThreadAttributeValue(ProcThreadAttributeSecurityCapabilities = 9, thread: false, input: true, additive: false)
    const uint PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint PROCESS_VM_READ = 0x0010;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const string Marker = "DECISION-C-PARENT-MARKER-0123456789";

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX
    {
        public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError, lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

    [DllImport("userenv.dll")] static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr caps, uint capCount, out IntPtr sid);
    [DllImport("userenv.dll")] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int information, out uint value, int length, out int returned);

    static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "run") return Parent(args[1]);
        if (args.Length == 4 && args[0] == "run-node") return NodeRun(args[1], args[2], args[3], "eval(require('fs').readFileSync('probe.js','utf8'))");
        if (args.Length == 5 && args[0] == "run-node") return NodeRun(args[1], args[2], args[3], args[4]);
        if (args.Length == 2 && args[0] == "pipe-run") return PipeRun(args[1]);
        if (args.Length == 2 && args[0] == "handle-run") return HandleRun(args[1]);
        if (args.Length == 5 && args[0] == "handle-child") return HandleChild(args[1], long.Parse(args[2]), args[3], args[4]);
        if (args.Length == 4 && args[0] == "pipe-child") return PipeChild(args[1], args[2], args[3]);
        if (args.Length == 6 && args[0] == "child") return Child(args[1], args[2], uint.Parse(args[3]), new IntPtr(long.Parse(args[4])), int.Parse(args[5]));
        Console.Error.WriteLine("usage: run <root> | child <plain|appcontainer> <root> <parentPid> <markerAddress> <listenerPort>");
        return 2;
    }

    static string Clean(string text) { return (text ?? "").Replace("\\", "/").Replace("\"", "'").Replace("\r", " ").Replace("\n", " "); }

    static int Parent(string root)
    {
        string shared = Path.Combine(root, "shared");
        string priv = Path.Combine(root, "private");
        Directory.CreateDirectory(shared);
        Directory.CreateDirectory(priv);
        File.WriteAllText(Path.Combine(priv, "secret.txt"), "private-secret-not-granted");
        File.WriteAllText(Path.Combine(shared, "granted.txt"), "shared-granted");
        foreach (var name in new[] { "child-plain.json", "child-appcontainer.json" })
            if (File.Exists(Path.Combine(shared, name))) File.Delete(Path.Combine(shared, name));

        // The parent holds a marker in its own heap; a child that can read the parent's memory recovers it.
        byte[] markerBytes = Encoding.ASCII.GetBytes(Marker);
        GCHandle pinned = GCHandle.Alloc(markerBytes, GCHandleType.Pinned);
        IntPtr markerAddress = pinned.AddrOfPinnedObject();

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        uint parentPid = (uint)Process.GetCurrentProcess().Id;
        string exe = Process.GetCurrentProcess().MainModuleFileName();

        // 1. Plain same-user child (the control): what a process of the same user, with no sandbox, can reach.
        var plain = Process.Start(new ProcessStartInfo(exe, string.Format("child plain \"{0}\" {1} {2} {3}", root, parentPid, markerAddress.ToInt64(), port))
            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = shared });
        plain.WaitForExit(120000);
        int plainExit = plain.ExitCode;

        // 2. AppContainer child: the same binary, launched with an AppContainer identity that holds no grant to the private folder.
        IntPtr sid;
        int hr = CreateAppContainerProfile(ContainerName, "Deszo decision C spike", "P6-DECISION-C isolation spike (test only)", IntPtr.Zero, 0, out sid);
        if (hr == ERROR_ALREADY_EXISTS)
        {
            int derived = DeriveAppContainerSidFromAppContainerName(ContainerName, out sid);
            if (derived != 0) { listener.Stop(); pinned.Free(); Console.WriteLine("{\"error\":\"derive_sid\",\"hresult\":" + derived + "}"); return 3; }
        }
        else if (hr != 0) { listener.Stop(); pinned.Free(); Console.WriteLine("{\"error\":\"create_profile\",\"hresult\":" + hr + "}"); return 3; }
        IntPtr sidText;
        ConvertSidToStringSidW(sid, out sidText);
        string sidString = Marshal.PtrToStringUni(sidText);
        LocalFree(sidText);
        // Grant the container read and modify on the shared folder only; the private folder is left without a grant.
        var icacls = Process.Start(new ProcessStartInfo("icacls.exe", string.Format("\"{0}\" /grant *{1}:(OI)(CI)M /T /Q", shared, sidString))
            { UseShellExecute = false, CreateNoWindow = true });
        icacls.WaitForExit(60000);
        int icaclsExit = icacls.ExitCode;

        int appContainerExit = -1; uint appContainerCode = 0; string launchError = null;
        IntPtr attributes = IntPtr.Zero, capabilities = IntPtr.Zero;
        try
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed " + Marshal.GetLastWin32Error());
            var caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(caps, capabilities, false);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilities,
                new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
                throw new Exception("UpdateProcThreadAttribute failed " + Marshal.GetLastWin32Error());
            var startup = new STARTUPINFOEX();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributes;
            var line = new StringBuilder(string.Format("\"{0}\" child appcontainer \"{1}\" {2} {3} {4}", exe, root, parentPid, markerAddress.ToInt64(), port));
            PROCESS_INFORMATION info;
            if (!CreateProcessW(exe, line, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, shared, ref startup, out info))
                throw new Exception("CreateProcessW failed " + Marshal.GetLastWin32Error());
            WaitForSingleObject(info.hProcess, 120000);
            GetExitCodeProcess(info.hProcess, out appContainerCode);
            appContainerExit = (int)appContainerCode;
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
        }
        catch (Exception error) { launchError = Clean(error.Message); }
        finally
        {
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
            listener.Stop();
            pinned.Free();
        }

        string plainJson = ReadOrNull(Path.Combine(shared, "child-plain.json"));
        string appJson = ReadOrNull(Path.Combine(shared, "child-appcontainer.json"));
        Console.WriteLine("{\"schemaVersion\":1,\"containerSid\":\"" + Clean(sidString) + "\",\"icaclsExit\":" + icaclsExit
            + ",\"plainChildExit\":" + plainExit + ",\"plainChild\":" + (plainJson ?? "null")
            + ",\"appContainerChildExit\":" + appContainerExit + ",\"appContainerLaunchError\":" + (launchError == null ? "null" : "\"" + launchError + "\"")
            + ",\"appContainerChild\":" + (appJson ?? "null") + "}");
        return 0;
    }

    static string ReadOrNull(string path) { return File.Exists(path) ? File.ReadAllText(path) : null; }

    static IntPtr ContainerSid(string name, out string text)
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, "Deszo decision C spike", "P6-DECISION-C isolation spike (test only)", IntPtr.Zero, 0, out sid);
        if (hr == ERROR_ALREADY_EXISTS) DeriveAppContainerSidFromAppContainerName(name, out sid);
        IntPtr sidText;
        ConvertSidToStringSidW(sid, out sidText);
        text = Marshal.PtrToStringUni(sidText);
        LocalFree(sidText);
        return sid;
    }

    static int RunContained(IntPtr sid, string exe, string arguments, string directory)
    {
        IntPtr attributes = IntPtr.Zero, capabilities = IntPtr.Zero;
        try
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed " + Marshal.GetLastWin32Error());
            var caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(caps, capabilities, false);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilities,
                new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
                throw new Exception("UpdateProcThreadAttribute failed " + Marshal.GetLastWin32Error());
            var startup = new STARTUPINFOEX();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributes;
            var line = new StringBuilder("\"" + exe + "\" " + arguments);
            PROCESS_INFORMATION info;
            if (!CreateProcessW(exe, line, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, directory, ref startup, out info))
                throw new Exception("CreateProcessW failed " + Marshal.GetLastWin32Error());
            WaitForSingleObject(info.hProcess, 60000);
            uint code;
            GetExitCodeProcess(info.hProcess, out code);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            return (int)code;
        }
        finally
        {
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
        }
    }

    const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;

    // Anonymous-pipe channel test. The parent creates two anonymous pipes. Each AppContainer child receives ONLY its own pipe's
    // client handle through PROC_THREAD_ATTRIBUTE_HANDLE_LIST. A same-user child is given the same numeric handle value through its
    // command line; it cannot use a handle that was not inherited. No pipe has a name, so nothing can open it by name.
    static int HandleRun(string root)
    {
        string shared = Path.Combine(root, "shared");
        string outDir = Path.Combine(shared, "out");
        Directory.CreateDirectory(outDir);
        foreach (var file in new[] { "anon-plain.json", "anon-engine.json", "anon-control.json" })
            if (File.Exists(Path.Combine(outDir, file))) File.Delete(Path.Combine(outDir, file));
        string engineText, controlText;
        IntPtr engineSid = ContainerSid("DeszoEngineSpike", out engineText);
        IntPtr controlSid = ContainerSid("DeszoControlSpike", out controlText);
        Process.Start(new ProcessStartInfo("icacls.exe", string.Format("\"{0}\" /grant *{1}:(OI)(CI)RX *{2}:(OI)(CI)RX /T /Q", shared, engineText, controlText))
            { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(60000);
        Process.Start(new ProcessStartInfo("icacls.exe", string.Format("\"{0}\" /grant *{1}:(OI)(CI)M *{2}:(OI)(CI)M /T /Q", outDir, engineText, controlText))
            { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(60000);

        string exe = Process.GetCurrentProcess().MainModule.FileName;
        var engineChannel = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        var controlChannel = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        var plainChannel = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        long engineHandle = engineChannel.ClientSafePipeHandle.DangerousGetHandle().ToInt64();
        long controlHandle = controlChannel.ClientSafePipeHandle.DangerousGetHandle().ToInt64();
        long plainHandle = plainChannel.ClientSafePipeHandle.DangerousGetHandle().ToInt64();
        engineChannel.WriteByte((byte)'E'); engineChannel.Flush();
        controlChannel.WriteByte((byte)'C'); controlChannel.Flush();
        plainChannel.WriteByte((byte)'P'); plainChannel.Flush();

        // Each child is also given the OTHER channels' numeric values, to test whether it can use them (the leak test).
        int engineExit = RunContainedWithHandles(engineSid, exe, string.Format("handle-child engine {0} \"{1}\" {2}", engineHandle, root, controlHandle), shared, engineChannel.ClientSafePipeHandle.DangerousGetHandle());
        int controlExit = RunContainedWithHandles(controlSid, exe, string.Format("handle-child control {0} \"{1}\" {2}", controlHandle, root, engineHandle), shared, controlChannel.ClientSafePipeHandle.DangerousGetHandle());
        // The plain child is an ordinary same-user Process.Start child. Process.Start passes inheritable handles, so this is a leak test.
        var plainProcess = Process.Start(new ProcessStartInfo(exe, string.Format("handle-child plain {0} \"{1}\" {2},{3}", plainHandle, root, engineHandle, controlHandle))
            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = shared });
        plainProcess.WaitForExit(120000);
        Console.WriteLine("{\"schemaVersion\":1,\"engineExit\":" + engineExit + ",\"controlExit\":" + controlExit + ",\"plainExit\":" + plainProcess.ExitCode
            + ",\"engine\":" + (ReadOrNull(Path.Combine(outDir, "anon-engine.json")) ?? "null")
            + ",\"control\":" + (ReadOrNull(Path.Combine(outDir, "anon-control.json")) ?? "null")
            + ",\"plain\":" + (ReadOrNull(Path.Combine(outDir, "anon-plain.json")) ?? "null") + "}");
        engineChannel.Dispose(); controlChannel.Dispose(); plainChannel.Dispose();
        return 0;
    }

    static string TryChannel(long handleValue)
    {
        try
        {
            using (var channel = new AnonymousPipeClientStream(PipeDirection.In, handleValue.ToString()))
            {
                return "read-byte=" + (char)channel.ReadByte();
            }
        }
        catch (Exception error) { return "denied: " + error.GetType().Name; }
    }

    static int HandleChild(string label, long handleValue, string root, string extras)
    {
        string outcome = "own " + TryChannel(handleValue);
        if (!string.IsNullOrEmpty(extras))
            foreach (var value in extras.Split(','))
                outcome += "; other " + value + " " + TryChannel(long.Parse(value));
        try { File.WriteAllText(Path.Combine(root, "shared", "out", "anon-" + label + ".json"), "{\"label\":\"" + label + "\",\"outcome\":\"" + Clean(outcome) + "\"}"); }
        catch (Exception) { return 4; }
        return 0;
    }

    static int RunContainedWithHandles(IntPtr sid, string exe, string arguments, string directory, IntPtr handle)
    {
        IntPtr attributes = IntPtr.Zero, capabilities = IntPtr.Zero, handleList = IntPtr.Zero;
        try
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed " + Marshal.GetLastWin32Error());
            var caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(caps, capabilities, false);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilities,
                new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
                throw new Exception("UpdateProcThreadAttribute(capabilities) failed " + Marshal.GetLastWin32Error());
            handleList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(handleList, handle);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Exception("UpdateProcThreadAttribute(handle list) failed " + Marshal.GetLastWin32Error());
            var startup = new STARTUPINFOEX();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributes;
            var line = new StringBuilder("\"" + exe + "\" " + arguments);
            PROCESS_INFORMATION info;
            if (!CreateProcessW(exe, line, IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, directory, ref startup, out info))
                throw new Exception("CreateProcessW failed " + Marshal.GetLastWin32Error());
            WaitForSingleObject(info.hProcess, 60000);
            uint code;
            GetExitCodeProcess(info.hProcess, out code);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            return (int)code;
        }
        finally
        {
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
        }
    }

    // Named-pipe channel test. The server (outside any container) admits ONE AppContainer SID (the control container). A same-user
    // medium-integrity child and a second AppContainer (the engine container, no grant) must both be refused at connect.
    static int PipeRun(string root)
    {
        string shared = Path.Combine(root, "shared");
        Directory.CreateDirectory(shared);
        foreach (var name in new[] { "pipe-plain.json", "pipe-engine.json", "pipe-control.json" })
            if (File.Exists(Path.Combine(shared, name))) File.Delete(Path.Combine(shared, name));
        string controlText, engineText;
        IntPtr controlSid = ContainerSid("DeszoControlSpike", out controlText);
        IntPtr engineSid = ContainerSid("DeszoEngineSpike", out engineText);
        // The control container may write the folder; the engine container may only read and run the spike binary. Both may write
        // only their own result files in the out folder, which is the one place the children report.
        string outDir = Path.Combine(shared, "out");
        Directory.CreateDirectory(outDir);
        Process.Start(new ProcessStartInfo("icacls.exe", string.Format("\"{0}\" /grant *{1}:(OI)(CI)M *{2}:(OI)(CI)RX /T /Q", shared, controlText, engineText))
            { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(60000);
        Process.Start(new ProcessStartInfo("icacls.exe", string.Format("\"{0}\" /grant *{1}:(OI)(CI)M *{2}:(OI)(CI)M /T /Q", outDir, controlText, engineText))
            { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(60000);

        string pipeName = "deszo-decision-c-" + Guid.NewGuid().ToString("N");
        // DECISION_C_PIPE_ACL selects the diagnostic: "control" (the per-container SID, default), "packages" (ALL APPLICATION PACKAGES), "default".
        string aclMode = Environment.GetEnvironmentVariable("DECISION_C_PIPE_ACL") ?? "control";
        NamedPipeServerStream server;
        if (aclMode == "default")
        {
            server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096);
        }
        else
        {
            var security = new PipeSecurity();
            string admitted = aclMode == "packages" ? "S-1-15-2-1" : controlText;
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(admitted), PipeAccessRights.FullControl, AccessControlType.Allow));
            server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security);
        }
        string serverOutcome = "no-connection";
        var acceptor = new Thread(() =>
        {
            try
            {
                server.WaitForConnection();
                var reader = new StreamReader(server);
                var writer = new StreamWriter(server) { AutoFlush = true };
                string line = reader.ReadLine();
                writer.WriteLine("reply-to:" + line);
                serverOutcome = "accepted:" + line;
            }
            catch (Exception error) { serverOutcome = "server-error:" + Clean(error.Message); }
        });
        acceptor.IsBackground = true;
        acceptor.Start();

        string exe = Process.GetCurrentProcess().MainModule.FileName;
        var plainProcess = Process.Start(new ProcessStartInfo(exe, string.Format("pipe-child plain {0} \"{1}\"", pipeName, root))
            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = shared });
        plainProcess.WaitForExit(120000);
        int plainExit = plainProcess.ExitCode;
        int engineExit = RunContained(engineSid, exe, string.Format("pipe-child engine {0} \"{1}\"", pipeName, root), shared);
        int controlExit = RunContained(controlSid, exe, string.Format("pipe-child control {0} \"{1}\"", pipeName, root), shared);
        acceptor.Join(5000);
        server.Dispose();

        Console.WriteLine("{\"schemaVersion\":1,\"serverOutcome\":\"" + Clean(serverOutcome) + "\",\"plainExit\":" + plainExit
            + ",\"engineExit\":" + engineExit + ",\"controlExit\":" + controlExit
            + ",\"plain\":" + (ReadOrNull(Path.Combine(outDir, "pipe-plain.json")) ?? "null")
            + ",\"engine\":" + (ReadOrNull(Path.Combine(outDir, "pipe-engine.json")) ?? "null")
            + ",\"control\":" + (ReadOrNull(Path.Combine(outDir, "pipe-control.json")) ?? "null") + "}");
        return 0;
    }

    static int PipeChild(string label, string pipeName, string root)
    {
        string outcome;
        try
        {
            using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
            {
                client.Connect(3000);
                var writer = new StreamWriter(client) { AutoFlush = true };
                writer.WriteLine("hello-from-" + label);
                var reader = new StreamReader(client);
                outcome = "connected; reply=" + reader.ReadLine();
            }
        }
        catch (Exception error) { outcome = "denied: " + error.GetType().Name + ": " + error.Message; }
        try { File.WriteAllText(Path.Combine(root, "shared", "out", "pipe-" + label + ".json"), "{\"label\":\"" + label + "\",\"outcome\":\"" + Clean(outcome) + "\"}"); }
        catch (Exception error) { return 4; }
        return 0;
    }

    // Node flags for the contained run. The environment variable lets a second run change them without a rebuild.
    static string NodeFlags { get { var flags = Environment.GetEnvironmentVariable("DECISION_C_NODE_FLAGS"); return flags ?? ""; } }

    // Runs a copy of Node inside the AppContainer, with only the shared folder granted. Tests whether the Engine runtime can start
    // contained at all, and what it can reach. The node.exe copy and the probe script live in the granted folder.
    static int NodeRun(string root, string nodeSource, string probeSource, string evalCode)
    {
        string shared = Path.Combine(root, "shared");
        string priv = Path.Combine(root, "private");
        Directory.CreateDirectory(shared);
        Directory.CreateDirectory(priv);
        File.WriteAllText(Path.Combine(priv, "secret.txt"), "private-secret-not-granted");
        string nodeCopy = Path.Combine(shared, "node.exe");
        File.Copy(nodeSource, nodeCopy, true);
        File.Copy(probeSource, Path.Combine(shared, "probe.js"), true);
        if (File.Exists(Path.Combine(shared, "node-ac.json"))) File.Delete(Path.Combine(shared, "node-ac.json"));
        Environment.SetEnvironmentVariable("DECISION_C_PRIVATE", priv);

        IntPtr sid;
        int hr = CreateAppContainerProfile(ContainerName, "Deszo decision C spike", "P6-DECISION-C isolation spike (test only)", IntPtr.Zero, 0, out sid);
        if (hr == ERROR_ALREADY_EXISTS) DeriveAppContainerSidFromAppContainerName(ContainerName, out sid);
        IntPtr sidText;
        ConvertSidToStringSidW(sid, out sidText);
        string sidString = Marshal.PtrToStringUni(sidText);
        LocalFree(sidText);
        var icacls = Process.Start(new ProcessStartInfo("icacls.exe", string.Format("\"{0}\" /grant *{1}:(OI)(CI)M /T /Q", shared, sidString))
            { UseShellExecute = false, CreateNoWindow = true });
        icacls.WaitForExit(60000);

        IntPtr attributes = IntPtr.Zero, capabilities = IntPtr.Zero;
        int exitCode = -1; string launchError = null;
        try
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed " + Marshal.GetLastWin32Error());
            var caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(caps, capabilities, false);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilities,
                new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
                throw new Exception("UpdateProcThreadAttribute failed " + Marshal.GetLastWin32Error());
            var startup = new STARTUPINFOEX();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributes;
            // cmd.exe captures Node's startup diagnostics, which a bare CreateProcess would lose.
            string cmdExe = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            // The probe is read through a relative path inside `node -e`, so no main-module realpath walk reaches the drive root.
            // evalCode "__MAIN__" starts the probe as the main module (the default Node start); anything else runs as `node -e`.
            string nodeInvocation = evalCode == "__MAIN__"
                ? string.Format("\"{0}\" {1} probe.js", nodeCopy, NodeFlags)
                : string.Format("\"{0}\" {1} -e \"{2}\"", nodeCopy, NodeFlags, evalCode);
            var line = new StringBuilder(string.Format("\"{0}\" /d /c \"{1} > \"{2}\" 2>&1\"", cmdExe, nodeInvocation, Path.Combine(shared, "node-stdout.txt")));
            PROCESS_INFORMATION info;
            if (!CreateProcessW(cmdExe, line, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, shared, ref startup, out info))
                throw new Exception("CreateProcessW failed " + Marshal.GetLastWin32Error());
            WaitForSingleObject(info.hProcess, 60000);
            uint code;
            GetExitCodeProcess(info.hProcess, out code);
            exitCode = (int)code;
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
        }
        catch (Exception error) { launchError = Clean(error.Message); }
        finally
        {
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
        }
        string result = ReadOrNull(Path.Combine(shared, "node-ac.json"));
        string nodeStdout;
        try { nodeStdout = ReadOrNull(Path.Combine(shared, "node-stdout.txt")); }
        catch (IOException error) { nodeStdout = "unreadable: " + error.Message; }
        if (nodeStdout != null && nodeStdout.Length > 1500) nodeStdout = nodeStdout.Substring(0, 1500);
        Console.WriteLine("{\"schemaVersion\":1,\"containerSid\":\"" + Clean(sidString) + "\",\"nodeExit\":" + exitCode
            + ",\"nodeFlags\":\"" + Clean(NodeFlags) + "\",\"nodeMode\":\"" + (evalCode == "__MAIN__" ? "main-module" : "eval") + "\""
            + ",\"launchError\":" + (launchError == null ? "null" : "\"" + launchError + "\"")
            + ",\"nodeStdout\":" + (nodeStdout == null ? "null" : "\"" + Clean(nodeStdout) + "\"")
            + ",\"nodeInContainer\":" + (result ?? "null") + "}");
        return 0;
    }

    static string Attempt(string name, Func<string> action)
    {
        try { return "{\"name\":\"" + name + "\",\"result\":\"allowed\",\"detail\":\"" + Clean(action()) + "\"}"; }
        catch (Exception error) { return "{\"name\":\"" + name + "\",\"result\":\"denied\",\"detail\":\"" + Clean(error.GetType().Name + ": " + error.Message) + "\"}"; }
    }

    static int Child(string mode, string root, uint parentPid, IntPtr markerAddress, int port)
    {
        string shared = Path.Combine(root, "shared");
        string priv = Path.Combine(root, "private");
        var results = new List<string>();
        uint isContainer = 0;
        IntPtr token;
        int returned;
        if (OpenProcessToken(GetCurrentProcess(), 0x0008, out token) && GetTokenInformation(token, 29, out isContainer, 4, out returned)) { }
        results.Add(Attempt("identity_is_appcontainer", () => isContainer == 1 ? "true" : "false"));
        results.Add(Attempt("open_parent_process_read_access", () =>
        {
            IntPtr handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, parentPid);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(handle);
            return "handle obtained";
        }));
        results.Add(Attempt("read_parent_memory_marker", () =>
        {
            IntPtr handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, parentPid);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var buffer = new byte[Marker.Length];
            IntPtr read;
            bool ok = ReadProcessMemory(handle, markerAddress, buffer, new IntPtr(buffer.Length), out read);
            CloseHandle(handle);
            if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return Encoding.ASCII.GetString(buffer) == Marker ? "marker recovered" : "bytes differ";
        }));
        results.Add(Attempt("read_private_not_granted_file", () => "length " + File.ReadAllText(Path.Combine(priv, "secret.txt")).Length));
        results.Add(Attempt("write_private_not_granted_store_path", () => { File.AppendAllText(Path.Combine(priv, "store-probe.txt"), "x"); return "written"; }));
        results.Add(Attempt("read_shared_granted_file", () => "length " + File.ReadAllText(Path.Combine(shared, "granted.txt")).Length));
        results.Add(Attempt("write_shared_granted_folder", () => { File.WriteAllText(Path.Combine(shared, "child-" + mode + "-probe.txt"), "ok"); return "written"; }));
        results.Add(Attempt("enumerate_user_profile", () => "entries " + Directory.GetFileSystemEntries(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)).Length));
        results.Add(Attempt("loopback_tcp_connect_to_parent", () =>
        {
            using (var client = new TcpClient())
            {
                client.Connect(IPAddress.Loopback, port);
                return "connected";
            }
        }));
        string json = "{\"mode\":\"" + mode + "\",\"tests\":[" + string.Join(",", results) + "]}";
        File.WriteAllText(Path.Combine(shared, "child-" + mode + ".json"), json);
        return 0;
    }
}

static class ProcessExtensions
{
    public static string MainModuleFileName(this Process process)
    {
        return process.MainModule.FileName;
    }
}
