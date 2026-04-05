import { exec } from 'child_process';

export class ProcessChecker {
  private intervalHandle: NodeJS.Timeout | null = null;

  start(callback: (pids: Set<number>) => void, intervalMs = 5000): void {
    const run = () => {
      if (process.platform === 'win32') {
        exec('tasklist /fo csv /nh', (err, stdout) => {
          if (err) return;
          const pids = new Set<number>();
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const cols = trimmed.split(',');
            if (cols.length < 2) continue;
            const pid = parseInt(cols[1].replace(/"/g, '').trim(), 10);
            if (!isNaN(pid)) pids.add(pid);
          }
          callback(pids);
        });
      } else {
        exec('ps -e -o pid=', (err, stdout) => {
          if (err) return;
          const pids = new Set<number>();
          for (const line of stdout.split('\n')) {
            const pid = parseInt(line.trim(), 10);
            if (!isNaN(pid)) pids.add(pid);
          }
          callback(pids);
        });
      }
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
}
