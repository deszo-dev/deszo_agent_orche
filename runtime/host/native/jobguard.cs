// Fail-stop Job holder for ADR-0006 native containment (prototype of the service-owned outer Job).
//
// `jobguard.exe admit [--crash-before-resume] [--leak] <exe> [args...]`
//   1. creates an anonymous Job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, which this process alone holds;
//   2. creates the child suspended, assigns it to the Job, and only then resumes it (pending-launch containment);
//   3. reports one JSON line: holder/child PIDs, whether the child is in the Job, and the Job's kernel handle count;
//   4. verifies ownership: exactly one handle to the Job may exist. A duplicate would keep the Job open after the
//      holder dies, so admission is refused in that case (ownershipVerified = false, exit code 3);
//   5. waits for stdin to close, then terminates the Job and exits.
// If the holder dies for any reason, the operating system closes its Job handle and kill-on-close ends every
// process still in the Job. --crash-before-resume exits between assignment and resume to exercise that window.
// --leak duplicates the Job handle into the child to simulate an inherited handle.
//
// This is not the protected service. It has no ACLs, no pipe and no authority; it exists so the containment mechanism
// can be tested natively on Windows (see runtime/tests/adr6-native-job.test.mjs).
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class JobGuard
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint PROCESS_DUP_HANDLE = 0x0040;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int ObjectBasicInformation = 0;

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct OBJECT_BASIC_INFORMATION
    {
        public uint Attributes; public uint GrantedAccess; public uint HandleCount; public uint PointerCount;
        public uint PagedPoolCharge; public uint NonPagedPoolCharge; public uint Reserved1, Reserved2, Reserved3;
        public uint NameInfoSize; public uint TypeInfoSize; public uint SecurityDescriptorSize; public long CreationTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint flags, IntPtr environment, string directory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")]
    static extern int NtQueryObject(IntPtr handle, int infoClass, ref OBJECT_BASIC_INFORMATION info, int length, out int returnLength);

    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
        return "\"" + argument.Replace("\"", "\\\"") + "\"";
    }

    // Returns the kernel handle count of the Job object; -1 when the query itself fails (reported, never trusted).
    static long HandleCount(IntPtr job, out int status)
    {
        var info = new OBJECT_BASIC_INFORMATION();
        int returned;
        status = NtQueryObject(job, ObjectBasicInformation, ref info, Marshal.SizeOf(typeof(OBJECT_BASIC_INFORMATION)), out returned);
        return status != 0 ? -1L : (long)info.HandleCount;
    }

    static int Main(string[] args)
    {
        int index = 0;
        if (args.Length < 2 || args[0] != "admit") { Console.Error.WriteLine("usage: jobguard admit [--crash-before-resume] [--leak] <exe> [args...]"); return 2; }
        index = 1;
        bool crashBeforeResume = false, leak = false;
        while (index < args.Length && args[index].StartsWith("--"))
        {
            if (args[index] == "--crash-before-resume") crashBeforeResume = true;
            else if (args[index] == "--leak") leak = true;
            else { Console.Error.WriteLine("unknown option " + args[index]); return 2; }
            index++;
        }
        if (index >= args.Length) { Console.Error.WriteLine("no child command"); return 2; }

        var commandLine = new StringBuilder();
        for (int i = index; i < args.Length; i++) { if (i > index) commandLine.Append(' '); commandLine.Append(Quote(args[i])); }

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { Console.Error.WriteLine("CreateJobObject failed " + Marshal.GetLastWin32Error()); return 4; }
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) { Console.Error.WriteLine("SetInformationJobObject failed"); return 4; }

        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out process))
        {
            Console.Error.WriteLine("CreateProcess failed " + Marshal.GetLastWin32Error());
            return 4;
        }
        // Pending launch: the child exists, has not run, and is not yet in the Job.
        if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateJobObject(job, 5); Console.Error.WriteLine("AssignProcessToJobObject failed " + Marshal.GetLastWin32Error()); return 4; }
        bool childInJob; IsProcessInJob(process.hProcess, job, out childInJob);
        bool holderInAnyJob; IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out holderInAnyJob);

        if (leak)
        {
            IntPtr childHandle = OpenProcess(PROCESS_DUP_HANDLE, false, process.dwProcessId);
            IntPtr duplicate;
            DuplicateHandle(GetCurrentProcess(), job, childHandle, out duplicate, 0, false, DUPLICATE_SAME_ACCESS);
            CloseHandle(childHandle);
        }

        if (crashBeforeResume)
        {
            Console.WriteLine("{\"holderPid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"childPid\":" + process.dwProcessId + ",\"stage\":\"suspended\"}");
            Console.Out.Flush();
            Environment.Exit(70);
        }

        ResumeThread(process.hThread);
        CloseHandle(process.hThread);
        int queryStatus;
        long handles = HandleCount(job, out queryStatus);
        bool ownershipVerified = handles == 1;
        Console.WriteLine("{\"holderPid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"childPid\":" + process.dwProcessId
            + ",\"childInJob\":" + (childInJob ? "true" : "false") + ",\"holderInAnyJob\":" + (holderInAnyJob ? "true" : "false")
            + ",\"jobHandleCount\":" + handles + ",\"handleQueryStatus\":" + queryStatus + ",\"ownershipVerified\":" + (ownershipVerified ? "true" : "false") + "}");
        Console.Out.Flush();
        // An unverified admission is reported, not trusted: the controller must not treat this Job as owned. The holder
        // keeps the Job open so the controller can see what a duplicate does (a holder death would not end the tree).
        // Stop: the controller closes stdin. Terminating the Job ends the owned tree.
        while (Console.In.ReadLine() != null) { }
        TerminateJobObject(job, 0);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        return ownershipVerified ? 0 : 3;
    }
}
