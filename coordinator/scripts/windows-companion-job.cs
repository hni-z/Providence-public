using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Start suspended so every descendant belongs to the job before any child code runs.
// Closing the supervisor closes this non-inherited job handle and stops its tree.
public sealed class ProvidenceWindowsJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedBytes; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Arguments(string command) {
        int count; IntPtr memory = CommandLineToArgvW(command, out count);
        Check(memory != IntPtr.Zero);
        try {
            var result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
    IntPtr job, process;
    public uint ProcessId { get; private set; }
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Open(string path, uint access, uint disposition) {
        var security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = 1 };
        var handle = CreateFileW(path, access, 3, ref security, disposition, 0x80, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    public static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static ProvidenceWindowsJob Start(string executable, string[] arguments, string directory, string stdout, string stderr) {
        var owned = new ProvidenceWindowsJob(); var info = new ProcessInfo();
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        try {
            owned.job = CreateJobObjectW(IntPtr.Zero, null); Check(owned.job != IntPtr.Zero);
            var limits = new ExtendedLimits(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(owned.job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            input = Open("NUL", 0x80000000, 3); output = Open(stdout, 0x40000000, 1); error = Open(stderr, 0x40000000, 1);
            var startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), flags = 0x100, input = input, output = output, error = error };
            var command = new StringBuilder(Quote(executable)); foreach (var arg in arguments) command.Append(' ').Append(Quote(arg));
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out info));
            owned.process = info.process; owned.ProcessId = info.pid;
            Check(AssignProcessToJobObject(owned.job, owned.process));
            Check(ResumeThread(info.thread) != 0xffffffff);
            return owned;
        } catch {
            if (info.process != IntPtr.Zero) TerminateProcess(info.process, 78);
            owned.Dispose(); throw;
        } finally {
            foreach (var handle in new[] { input, output, error, info.thread }) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    public bool Wait(int milliseconds) {
        uint result = WaitForSingleObject(process, (uint)milliseconds);
        if (result == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
        return result == 0;
    }
    public uint ExitCode { get { uint code; Check(GetExitCodeProcess(process, out code)); return code; } }
    public void Dispose() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    }
}
