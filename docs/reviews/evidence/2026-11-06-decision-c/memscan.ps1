# P6-DECISION-C evidence helper. Reads the committed private heap of ONE named process (the test-owned Lifecycle Host)
# and records every distinct 64-character hexadecimal run it finds. It never prints the values; it writes them to -OutFile,
# which the driver reads and then deletes. It models any same-OS-user process (a child of the Engine, or a verifier child).
param(
    [Parameter(Mandatory = $true)][uint32]$ProcessId,
    [Parameter(Mandatory = $true)][string]$OutFile
)

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class MemScan
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryBasicInformation
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryBasicInformation information, IntPtr length);

    public static long RegionsScanned;
    public static long BytesScanned;

    public static string[] Scan(uint processId)
    {
        // PROCESS_VM_READ | PROCESS_QUERY_INFORMATION
        IntPtr process = OpenProcess(0x0010 | 0x0400, false, processId);
        if (process == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess refused read access to the process");
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            long address = 0;
            const long limit = 0x7FFFFFFFFFFF;
            int infoSize = Marshal.SizeOf(typeof(MemoryBasicInformation));
            while (address < limit)
            {
                MemoryBasicInformation info;
                if (VirtualQueryEx(process, (IntPtr)address, out info, (IntPtr)infoSize) == IntPtr.Zero) break;
                long size = info.RegionSize.ToInt64();
                if (size <= 0) break;
                // MEM_COMMIT, MEM_PRIVATE, readable (not PAGE_NOACCESS, not PAGE_GUARD)
                bool readable = info.State == 0x1000 && info.Type == 0x20000 && info.Protect != 0
                    && (info.Protect & 0x01) == 0 && (info.Protect & 0x100) == 0;
                if (readable && size <= 256L * 1024 * 1024)
                {
                    var buffer = new byte[size];
                    IntPtr read;
                    if (ReadProcessMemory(process, info.BaseAddress, buffer, (IntPtr)size, out read))
                    {
                        RegionsScanned++;
                        BytesScanned += read.ToInt64();
                        Extract(buffer, read.ToInt64(), found);
                    }
                }
                address = info.BaseAddress.ToInt64() + size;
            }
        }
        finally { CloseHandle(process); }
        var list = new string[found.Count];
        found.CopyTo(list);
        return list;
    }

    static bool IsHex(byte c)
    {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }

    static void Extract(byte[] buffer, long length, HashSet<string> found)
    {
        long run = 0;
        for (long i = 0; i <= length; i++)
        {
            bool hex = i < length && IsHex(buffer[i]);
            if (hex) { run++; continue; }
            if (run == 64)
            {
                long start = i - 64;
                if (start == 0 || !IsHex(buffer[start - 1]))
                    found.Add(Encoding.ASCII.GetString(buffer, (int)start, 64));
            }
            run = 0;
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$candidates = [MemScan]::Scan($ProcessId)
$record = [ordered]@{
    schemaVersion = 1
    processId = $ProcessId
    candidateCount = $candidates.Count
    regionsScanned = [MemScan]::RegionsScanned
    bytesScanned = [MemScan]::BytesScanned
    candidates = @($candidates)
}
[System.IO.File]::WriteAllText($OutFile, ($record | ConvertTo-Json -Depth 4))
