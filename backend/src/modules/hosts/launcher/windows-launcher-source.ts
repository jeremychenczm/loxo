/**
 * Source of the Windows agent launcher, compiled on first use with the .NET
 * Framework compiler that ships with Windows. Usage:
 *
 *   loxo-launcher.exe --parent <pid> --tag <tag> -- <command> [args...]
 *   loxo-launcher.exe --self-test
 *
 * The launcher puts itself in a job object that kills every member when its
 * last handle closes, then starts the agent, which inherits the launcher's
 * stdio and its job. It exits when the agent exits (with the agent's code),
 * when the parent process exits, or when it is killed; each closes the job
 * handle, so the agent and everything it started, including descendants
 * whose own parent already exited, die with it.
 */
export const WINDOWS_LAUNCHER_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class LoxoLauncher
{
    const uint KillOnJobClose = 0x2000;
    const int ExtendedLimitInformation = 9;
    const int SetupFailed = 70;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    static int Fail(string message)
    {
        Console.Error.WriteLine("loxo-launcher: " + message);
        return SetupFailed;
    }

    static string JoinJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return "CreateJobObject failed (" + Marshal.GetLastWin32Error() + ")";
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = KillOnJobClose;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            return "SetInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")";
        // The handle is never closed explicitly: it closes when this process ends, however it ends.
        if (!AssignProcessToJobObject(job, GetCurrentProcess()))
            return "AssignProcessToJobObject failed (" + Marshal.GetLastWin32Error() + ")";
        return null;
    }

    // Quotes one argument so CommandLineToArgvW and the C runtime read it back unchanged.
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        for (int i = 0; i < arg.Length; i++)
        {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
            if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
            if (arg[i] == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', slashes); sb.Append(arg[i]); }
        }
        return sb.Append('"').ToString();
    }

    static WaitHandle Exited(Process process)
    {
        var handle = new ManualResetEvent(false);
        handle.SafeWaitHandle = new Microsoft.Win32.SafeHandles.SafeWaitHandle(process.Handle, false);
        return handle;
    }

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            string error = JoinJob();
            return error == null ? 0 : Fail(error);
        }

        int parentPid = -1;
        int split = -1;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--") { split = i; break; }
            if (args[i] == "--parent" && i + 1 < args.Length) parentPid = int.Parse(args[++i]);
            else if (args[i] == "--tag" && i + 1 < args.Length) i++;
        }
        if (parentPid <= 0 || split < 0 || split + 1 >= args.Length)
            return Fail("usage: --parent <pid> --tag <tag> -- <command> [args...]");

        Process parent;
        try
        {
            parent = Process.GetProcessById(parentPid);
            // A parent that started after us is a reused pid: the real one is gone.
            if (parent.StartTime > Process.GetCurrentProcess().StartTime) return Fail("parent already exited");
        }
        catch (ArgumentException)
        {
            return Fail("parent already exited");
        }

        string jobError = JoinJob();
        if (jobError != null) return Fail(jobError);

        var command = new StringBuilder();
        for (int i = split + 2; i < args.Length; i++)
        {
            if (command.Length > 0) command.Append(' ');
            command.Append(Quote(args[i]));
        }
        var start = new ProcessStartInfo(args[split + 1], command.ToString());
        start.UseShellExecute = false;

        Process agent;
        try
        {
            agent = Process.Start(start);
        }
        catch (Exception e)
        {
            return Fail("could not start " + args[split + 1] + ": " + e.Message);
        }

        int which = WaitHandle.WaitAny(new[] { Exited(agent), Exited(parent) });
        if (which == 0)
        {
            agent.WaitForExit();
            return agent.ExitCode;
        }
        return 1;
    }
}
`;
