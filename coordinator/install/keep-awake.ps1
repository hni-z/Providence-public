# Fixed helper invoked in a private child process. No power or lock settings change.
# Windows API: https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class ProvidenceIdleSleepLease {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);

    public static int Run() {
        int result = 0;
        Thread worker = new Thread(() => {
            bool held = false;
            try {
                // ES_CONTINUOUS | ES_SYSTEM_REQUIRED. No display or away mode.
                if (SetThreadExecutionState(0x80000001u) == 0) {
                    Console.Out.WriteLine("PROVIDENCE_KEEP_AWAKE_UNAVAILABLE");
                    Console.Out.Flush(); result = 2; return;
                }
                held = true;
                Console.Out.WriteLine("PROVIDENCE_KEEP_AWAKE_READY");
                Console.Out.Flush();
                using (Stream input = Console.OpenStandardInput()) {
                    byte[] buffer = new byte[1];
                    // EOF follows an explicit stop or the parent process dying.
                    while (input.Read(buffer, 0, 1) > 0) { }
                }
            } catch { result = 2; }
            finally {
                // Reset on the SAME dedicated thread that acquired the assertion.
                if (held) SetThreadExecutionState(0x80000000u);
            }
        });
        worker.IsBackground = false;
        worker.Start(); worker.Join();
        return result;
    }
}
'@
    exit ([ProvidenceIdleSleepLease]::Run())
} catch {
    [Console]::Out.WriteLine('PROVIDENCE_KEEP_AWAKE_UNAVAILABLE')
    [Console]::Out.Flush()
    exit 2
}
