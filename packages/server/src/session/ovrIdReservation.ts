const TTL_MS = 5 * 60 * 1000;

/**
 * Tracks pre-minted ovrIds reserved at PTY spawn time, before the live Claude
 * session file exists. Consumed by stateManager.addOrUpdate so the new session
 * adopts the reserved id instead of minting a fresh one (which would produce a
 * duplicate OverlordSession record or split a resume lineage).
 *
 * Two resolution keys:
 *  - marker  (___OVR:<marker> in --name flag) — primary path
 *  - pid     — fallback when claude --resume drops the --name marker
 */
export class OvrIdReservation {
  private byMarker = new Map<string, { ovrId: string; ts: number }>();
  private byPid    = new Map<number, { ovrId: string; ts: number }>();

  generate(): string {
    return 'ovr-' + Math.random().toString(36).slice(2, 10);
  }

  /** Mint a fresh ovrId and reserve it under marker. */
  mint(marker: string): string {
    this.pruneMarkers();
    const ovrId = this.generate();
    this.byMarker.set(marker, { ovrId, ts: Date.now() });
    return ovrId;
  }

  /** Reserve an EXISTING ovrId under marker (resume: reuse lineage's ovrId). */
  reserveForMarker(marker: string, ovrId: string): void {
    this.pruneMarkers();
    this.byMarker.set(marker, { ovrId, ts: Date.now() });
  }

  consumeByMarker(marker: string): string | undefined {
    const e = this.byMarker.get(marker);
    if (!e) return undefined;
    this.byMarker.delete(marker);
    return e.ovrId;
  }

  reserveForPid(pid: number, ovrId: string): void {
    if (!pid) return;
    const now = Date.now();
    for (const [p, e] of this.byPid) {
      if (now - e.ts > TTL_MS) this.byPid.delete(p);
    }
    this.byPid.set(pid, { ovrId, ts: now });
  }

  consumeByPid(pid: number): string | undefined {
    const e = this.byPid.get(pid);
    if (!e) return undefined;
    this.byPid.delete(pid);
    return e.ovrId;
  }

  private pruneMarkers(): void {
    const now = Date.now();
    for (const [marker, e] of this.byMarker) {
      if (now - e.ts > TTL_MS) this.byMarker.delete(marker);
    }
  }
}
