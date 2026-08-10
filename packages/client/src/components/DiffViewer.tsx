import React, { useEffect, useMemo, useState } from 'react';
import { diffWordsWithSpace } from 'diff';
import styles from './DiffViewer.module.css';
import {
  buildEditContext,
  fetchFileText,
  expandBefore,
  expandAfter,
  REASON_LABEL,
  DEFAULT_CONTEXT,
  type DiffHunk,
  type DiffRow,
  type EditContext,
} from '../lib/editContext';

interface Props {
  oldString: string;
  newString: string;
  oldStringTruncated?: boolean;
  newStringTruncated?: boolean;
  /** Absolute file path from the tool call; without it there is no context to fetch. */
  filePath?: string;
  wrap?: boolean;
}

const EXPAND_STEP = 20;
/** Rendering is plain divs — this is the ceiling before it costs more than it's worth. */
const MAX_ROWS = 2000;

/** Word-level marks for a hunk that swapped exactly one line for one other. */
function wordSpans(a: string, b: string): { del: React.ReactNode[]; add: React.ReactNode[] } {
  const parts = diffWordsWithSpace(a, b);
  const del: React.ReactNode[] = [];
  const add: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part.added) add.push(<span key={i} className={styles.word}>{part.value}</span>);
    else if (part.removed) del.push(<span key={i} className={styles.word}>{part.value}</span>);
    else { del.push(part.value); add.push(part.value); }
  });
  return { del, add };
}

function Row({ row, content }: { row: DiffRow; content?: React.ReactNode }) {
  const cls = row.type === 'add' ? styles.add : row.type === 'del' ? styles.del : styles.ctx;
  const marker = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
  const num = row.type === 'del' ? row.oldLine : row.newLine;
  return (
    <div className={`${styles.row} ${cls}`}>
      <span className={styles.gutter}>{num ?? ''}</span>
      <span className={styles.marker}>{marker}</span>
      <span className={styles.text}>{content ?? (row.text === '' ? ' ' : row.text)}</span>
    </div>
  );
}

function HunkRows({ hunk }: { hunk: DiffHunk }) {
  // Only a clean 1:1 line replacement gets word marks — on bigger hunks the
  // per-word colouring is noise rather than signal.
  const dels = hunk.rows.filter(r => r.type === 'del');
  const adds = hunk.rows.filter(r => r.type === 'add');
  const pair = dels.length === 1 && adds.length === 1
    ? wordSpans(dels[0].text, adds[0].text)
    : null;
  return (
    <>
      {hunk.rows.map((row, i) => (
        <Row
          key={i}
          row={row}
          content={pair && row === dels[0] ? pair.del : pair && row === adds[0] ? pair.add : undefined}
        />
      ))}
    </>
  );
}

export const DiffViewer = React.memo(function DiffViewer({
  oldString,
  newString,
  oldStringTruncated,
  newStringTruncated,
  filePath,
  wrap,
}: Props) {
  // `undefined` means "still fetching". Cases that never fetch start at `null`
  // so they render the diff immediately instead of flashing "loading".
  const [fileText, setFileText] = useState<string | null | undefined>(
    () => (!filePath || oldString === '') ? null : undefined,
  );
  const [extraBefore, setExtraBefore] = useState(0);
  const [extraAfter, setExtraAfter] = useState(0);

  // Lazy: this component only mounts when the diff is expanded, so the request
  // never fires from a snapshot re-render.
  useEffect(() => {
    let cancelled = false;
    if (!filePath || oldString === '') { setFileText(null); return; }
    setFileText(undefined);
    fetchFileText(filePath).then(text => { if (!cancelled) setFileText(text); });
    return () => { cancelled = true; };
  }, [filePath, oldString]);

  const ctx: EditContext | null = useMemo(() => {
    if (fileText === undefined) return null;
    return buildEditContext({
      oldString,
      newString,
      oldStringTruncated,
      newStringTruncated,
      fileText,
      context: DEFAULT_CONTEXT,
    });
  }, [oldString, newString, oldStringTruncated, newStringTruncated, fileText]);

  const expanded = useMemo(() => {
    if (!ctx) return null;
    const lines = ctx.fileLines;
    if (!lines || ctx.hunks.length === 0) return { hunks: ctx.hunks, head: [] as DiffRow[], tail: [] as DiffRow[] };
    return {
      hunks: ctx.hunks,
      head: extraBefore > 0 ? expandBefore(lines, ctx.hunks[0], extraBefore) : [],
      tail: extraAfter > 0 ? expandAfter(lines, ctx.hunks[ctx.hunks.length - 1], extraAfter) : [],
    };
  }, [ctx, extraBefore, extraAfter]);

  if (!ctx || !expanded) {
    return <div className={styles.wrap}><div className={styles.loading}>loading file context…</div></div>;
  }

  const label = filePath || oldString === '' ? REASON_LABEL[ctx.reason] : REASON_LABEL['no-path'];
  const canExpand = !!ctx.fileLines;
  const totalRows = expanded.hunks.reduce((n, h) => n + h.rows.length, 0) + expanded.head.length + expanded.tail.length;
  const capped = totalRows > MAX_ROWS;
  const firstLine = ctx.fileLines ? (expanded.head[0]?.newLine ?? expanded.hunks[0]?.newStart ?? 1) : 1;
  const lastLine = ctx.fileLines
    ? (expanded.tail[expanded.tail.length - 1]?.newLine
      ?? expanded.hunks[expanded.hunks.length - 1]?.rows.reduce((n, r) => r.newLine ?? n, 0))
    : 0;

  return (
    <div className={styles.wrap}>
      {label && <div className={styles.banner}>{label}</div>}
      <div className={`${styles.rows} ${wrap ? styles.rowWrap : ''}`}>
        {capped ? (
          <div className={styles.loading}>
            {totalRows.toLocaleString()} lines — too many to render. Collapse the context to view.
          </div>
        ) : (
          <>
            {canExpand && firstLine > 1 && (
              <button className={styles.expander} onClick={() => setExtraBefore(n => n + EXPAND_STEP)}>
                ⌃ expand {Math.min(EXPAND_STEP, firstLine - 1)} lines above
              </button>
            )}
            {expanded.head.map((row, i) => <Row key={`h${i}`} row={row} />)}
            {expanded.hunks.map((hunk, i) => (
              <React.Fragment key={i}>
                {i > 0 && <div className={styles.expander} style={{ cursor: 'default' }}>⋯</div>}
                <HunkRows hunk={hunk} />
              </React.Fragment>
            ))}
            {expanded.tail.map((row, i) => <Row key={`t${i}`} row={row} />)}
            {canExpand && ctx.fileLines && lastLine < ctx.fileLines.length && (
              <button className={styles.expander} onClick={() => setExtraAfter(n => n + EXPAND_STEP)}>
                ⌄ expand {Math.min(EXPAND_STEP, ctx.fileLines.length - lastLine)} lines below
              </button>
            )}
          </>
        )}
      </div>
      {canExpand && (extraBefore > 0 || extraAfter > 0) && (
        <div className={styles.footer}>
          <button className={styles.footerBtn} onClick={() => { setExtraBefore(0); setExtraAfter(0); }}>
            collapse context
          </button>
        </div>
      )}
    </div>
  );
});
