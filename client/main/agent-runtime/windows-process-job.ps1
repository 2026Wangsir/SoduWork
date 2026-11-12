# Own one execution runtime and its future descendants. The unnamed job handle
# is never inherited; losing this helper also closes the job and reaps its tree.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class SoduWorkProcessJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit; public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  IntPtr job;
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public SoduWorkProcessJob(int pid, long expectedCreated) {
    // Keep the process handle until assignment: a PID cannot be reused under us.
    IntPtr process = OpenProcess(0x0101 | 0x1000, false, pid);
    Check(process != IntPtr.Zero);
    try {
      long created, exited, kernel, user;
      Check(GetProcessTimes(process, out created, out exited, out kernel, out user));
      if (new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds() != expectedCreated)
        throw new InvalidOperationException("Runtime process identity changed");
      job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero); Check(job != IntPtr.Zero);
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, without breakaway flags.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
      Check(AssignProcessToJobObject(job, process));
    } catch { Dispose(); throw; }
    finally { CloseHandle(process); }
  }
  public void Stop() {
    Check(TerminateJobObject(job, 1));
    var deadline = DateTime.UtcNow.AddSeconds(5);
    while (true) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.ActiveProcesses == 0) return;
      if (DateTime.UtcNow >= deadline) throw new TimeoutException("Runtime job still has active processes");
      Thread.Sleep(20);
    }
  }
  public void Dispose() { if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } }
}
'@
$runtimeJob = [SoduWorkProcessJob]::new([int]$env:SODUWORK_JOB_PID, [long]$env:SODUWORK_JOB_CREATED)
try {
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
  $runtimeJob.Stop()
  [Console]::Out.WriteLine('stopped')
} finally { $runtimeJob.Dispose() }
