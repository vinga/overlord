import * as fs from 'fs';
import type { ArchiveEntry } from './archiveManager.js';

export interface ArchiveStats {
  sessionId: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  durationMs: number | null;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  compactCount: number;
  transcriptCount: number;
  totalLines: number;
  model?: string;
}

interface TranscriptLine {
  type?: string;
  subtype?: string;
  timestamp?: string;
  message?: {
    model?: string;
    content?: unknown;
  };
}

export function computeArchiveStats(entry: ArchiveEntry): ArchiveStats {
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolUseCount = 0;
  let compactCount = 0;
  let totalLines = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  let model: string | undefined = entry.model;

  for (const t of entry.transcripts) {
    if (!fs.existsSync(t.path)) continue;
    let raw: string;
    try { raw = fs.readFileSync(t.path, 'utf-8'); } catch { continue; }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      totalLines++;
      let parsed: TranscriptLine | null = null;
      try { parsed = JSON.parse(line) as TranscriptLine; } catch { continue; }
      if (!parsed) continue;

      if (parsed.timestamp) {
        const ts = Date.parse(parsed.timestamp);
        if (!Number.isNaN(ts)) {
          if (earliest === null || ts < earliest) earliest = ts;
          if (latest === null || ts > latest) latest = ts;
        }
      }

      if (parsed.type === 'user') {
        userMessageCount++;
      } else if (parsed.type === 'assistant') {
        assistantMessageCount++;
        if (!model && parsed.message?.model) model = parsed.message.model;
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string }>) {
            if (block?.type === 'tool_use') toolUseCount++;
          }
        }
      } else if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
        compactCount++;
      }
    }
  }

  const startedAt = earliest !== null ? new Date(earliest).toISOString() : null;
  const lastActivityAt = latest !== null ? new Date(latest).toISOString() : null;
  const finishedAt = entry.archivedAt || lastActivityAt;
  const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
  const durationMs = earliest !== null && !Number.isNaN(finishedMs)
    ? Math.max(0, finishedMs - earliest)
    : null;

  return {
    sessionId: entry.sessionId,
    startedAt,
    finishedAt: finishedAt ?? null,
    lastActivityAt,
    durationMs,
    userMessageCount,
    assistantMessageCount,
    toolUseCount,
    compactCount,
    transcriptCount: entry.transcripts.length,
    totalLines,
    model,
  };
}
