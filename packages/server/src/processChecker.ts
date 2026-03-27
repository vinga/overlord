import { exec } from 'child_process';

export class ProcessChecker {
  private alivePids: Set<number> = new Set();
  private intervalHandle: NodeJS.Timeout | null = null;

  start(callback: (pids: Set<number>) => void, intervalMs = 5000): void {
    const run = () => {
      exec('tasklist /fo csv /nh', (err, stdout) => {
        if (err) return;
        const pids = new Set<number>();
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // CSV columns: "Image Name","PID","Session Name","Session#","Mem Usage"
          const cols = trimmed.split(',');
          if (cols.length < 2) continue;
          const pidStr = cols[1].replace(/"/g, '').trim();
          const pid = parseInt(pidStr, 10);
          if (!isNaN(pid)) {
            pids.add(pid);
          }
        }
        this.alivePids = pids;
        callback(pids);
      });
    };

    run();
    this.intervalHandle = setInterval(run, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }
}
