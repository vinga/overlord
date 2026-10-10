import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import styles from './FileEditorOverlay.module.css';
import { languageForPath, highlightToLines } from '../lib/highlightLines';
import { renderMarkdown } from '../lib/renderMarkdown';
import 'highlight.js/styles/github-dark.css';

const FILE_EDITOR_MODE_KEY = 'overlord:fileEditorMode';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTS.has(p.slice(dot + 1).toLowerCase());
}

/**
 * Where the viewer reads and writes. The default goes through `/api/file`
 * (absolute paths, room-root guard); the room file browser plugs in
 * `/api/room-file`, which additionally refuses gitignored and deny-listed files.
 */
export interface FileSource {
  load: (path: string) => Promise<Response>;
  save: (path: string, content: string) => Promise<Response>;
  imageUrl: (path: string) => string;
  /** Absolute path for "Open in IDE"; null hides the button. */
  absolutePath: (path: string) => string | null;
}

const DEFAULT_SOURCE: FileSource = {
  load: (path) => fetch(`/api/file?path=${encodeURIComponent(path)}`),
  save: (path, content) => fetch('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }),
  imageUrl: (path) => `/api/file-raw?path=${encodeURIComponent(path)}`,
  absolutePath: (path) => path,
};

interface Props {
  path: string;
  line?: number;
  cwd?: string;
  onClose: () => void;
}

interface ViewProps {
  path: string;
  line?: number;
  cwd?: string;
  /** Omit for the default `/api/file` source (with cwd-relative retry). */
  source?: FileSource;
  /** Shows a close button; called after the unsaved-changes confirm. */
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
}

type Mode = 'preview' | 'edit';

export function FileEditorOverlay({ path, line, cwd, onClose }: Props) {
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => { dirtyRef.current = d; }, []);

  const handleClose = useCallback(() => {
    if (dirtyRef.current && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [onClose]);

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  }, [handleClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleClose]);

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <FileEditorView
        className={styles.modal}
        path={path}
        line={line}
        cwd={cwd}
        onClose={handleClose}
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}

export function FileEditorView({ path, line, cwd, source, onClose, onDirtyChange, className }: ViewProps) {
  const src = source ?? DEFAULT_SOURCE;
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [writable, setWritable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tooLarge, setTooLarge] = useState(false);
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(FILE_EDITOR_MODE_KEY);
    return (saved === 'edit' ? 'edit' : 'preview') as Mode;
  });
  const [saving, setSaving] = useState(false);
  const [saveFlash, setSaveFlash] = useState('');
  const [saveError, setSaveError] = useState('');
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isMarkdown = path.toLowerCase().endsWith('.md');
  const isImage = isImagePath(path);
  const isDirty = !isImage && content !== original;
  // Every text file gets the numbered, highlighted code view in preview mode.
  // Markdown is the one exception — it renders as markdown instead — unless a
  // line reference was passed, since rendered-markdown lines don't map back to
  // source lines.
  const hasLineView = !isImage && (!isMarkdown || line !== undefined);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Repo-relative references (`/src/File.tsx`) 404 as-is; retry against the
  // session cwd. `inferred` drives a visible warning — the viewer is then
  // showing a guess, not the literal path that was clicked.
  const [effective, setEffective] = useState<{ path: string; inferred: boolean }>({ path, inferred: false });
  useEffect(() => { setEffective({ path, inferred: false }); }, [path, cwd]);
  // Only the default source takes absolute paths; a custom source already
  // resolves against its own root, so there is nothing to retry.
  const cwdCandidate = !source && cwd && !path.startsWith(cwd)
    ? `${cwd.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
    : null;

  useEffect(() => {
    if (isImage) {
      setLoading(false);
      setTooLarge(false);
      return;
    }
    setLoading(true);
    setTooLarge(false);
    setSaveError('');
    let cancelled = false;
    (async () => {
      try {
        let r = await src.load(path);
        let used = { path, inferred: false };
        if (r.status === 404 && cwdCandidate) {
          const retry = await src.load(cwdCandidate);
          if (retry.ok || retry.status === 413) {
            r = retry;
            used = { path: cwdCandidate, inferred: true };
          }
        }
        if (cancelled) return;
        setEffective(used);
        if (r.status === 413 || r.status === 415) { setTooLarge(true); setLoading(false); return; }
        if (!r.ok) {
          const reason = await r.json().then((b: { error?: string }) => b.error).catch(() => undefined);
          if (cancelled) return;
          setSaveError(reason ? `Can't open: ${reason}` : `Error ${r.status}`);
          setLoading(false);
          return;
        }
        const data = await r.json() as { content: string; writable: boolean };
        setContent(data.content);
        setOriginal(data.content);
        setWritable(data.writable);
        // Preview always wins on open — viewing a file is the common case, and
        // landing in an editable textarea invites accidental edits.
        if (line !== undefined) setMode('preview');
        setLoading(false);
      } catch (err) {
        if (!cancelled) { setSaveError(String(err)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [path, isMarkdown, isImage, line, cwdCandidate, src]);

  useEffect(() => {
    if (!loading && mode === 'preview' && hasLineView) {
      highlightRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [loading, mode, hasLineView, line, path]);

  const codeLines = useMemo(
    () => (hasLineView && !loading ? content.split('\n') : null),
    [hasLineView, loading, content],
  );

  // Highlighted twin of `codeLines`: same length, or null when the language is
  // unknown / the file is too big, in which case the plain lines are rendered.
  const language = useMemo(() => languageForPath(effective.path), [effective.path]);
  const highlighted = useMemo(
    () => (codeLines ? highlightToLines(content, language) : null),
    [codeLines, content, language],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError('');
    try {
      const r = await src.save(effective.path, content);
      if (!r.ok) {
        const reason = await r.json().then((b: { error?: string }) => b.error).catch(() => undefined);
        setSaveError(reason ?? (r.status === 403 ? 'File is read-only' : `Error ${r.status}`));
        setSaving(false);
        return;
      }
      setOriginal(content);
      setSaveFlash('Saved');
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setSaveFlash(''), 2000);
    } catch (err) {
      setSaveError(String(err));
    }
    setSaving(false);
  }, [effective.path, content, src]);

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const handleModeChange = useCallback((m: Mode) => {
    setMode(m);
    try { localStorage.setItem(FILE_EDITOR_MODE_KEY, m); } catch { /* storage blocked */ }
  }, []);

  const ideTarget = src.absolutePath(effective.path);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const displayPath = cwd && effective.path.startsWith(cwd + '/')
    ? effective.path.slice(cwd.length + 1)
    : effective.path;

  const dirPart = displayPath.includes('/') ? displayPath.slice(0, displayPath.lastIndexOf('/') + 1) : '';
  const filePart = displayPath.slice(dirPart.length);

  return (
    <div className={className}>
      <div className={styles.header}>
        <div className={styles.filePath}>
          {dirPart}<span>{filePart}</span>
        </div>
        {effective.inferred && (
          <span
            className={styles.inferredBadge}
            title={`"${path}" was not found on disk — showing ${effective.path}, auto-inferred from the session workspace. It may be a different file.`}
          >
            ⚠ auto-inferred
          </span>
        )}
        <div className={styles.controls}>
          {!isImage && (
            <div className={styles.toggleGroup}>
              <button
                className={`${styles.toggleBtn} ${mode === 'preview' ? styles.active : ''}`}
                onClick={() => handleModeChange('preview')}
              >Preview</button>
              <button
                className={`${styles.toggleBtn} ${mode === 'edit' ? styles.active : ''}`}
                onClick={() => handleModeChange('edit')}
              >Edit</button>
            </div>
          )}
          {saveFlash && <span className={styles.saveFlash}>{saveFlash}</span>}
          {saveError && !saveFlash && <span className={styles.saveError}>{saveError}</span>}
          {!isImage && (
            <button
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={!isDirty || !writable || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {onClose && (
            <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">✕</button>
          )}
        </div>
      </div>

      <div className={styles.body}>
        {loading && <div className={styles.loading}>Loading…</div>}
        {tooLarge && (
          <div className={styles.tooLarge}>
            <span>File too large or binary — can't show it inline</span>
            {ideTarget && (
              <button
                className={styles.openIdeBtn}
                onClick={() => {
                  void fetch('/api/open-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ideTarget }) });
                }}
              >Open in IDE</button>
            )}
          </div>
        )}
        {!loading && isImage && (
          <div className={styles.imageWrap}>
            {saveError
              ? <span className={styles.saveError}>{saveError}</span>
              : (
                <img
                  className={styles.imageView}
                  src={src.imageUrl(effective.path)}
                  alt={filePart}
                  onError={() => {
                    if (!effective.inferred && cwdCandidate) {
                      setEffective({ path: cwdCandidate, inferred: true });
                    } else {
                      setSaveError('Failed to load image');
                    }
                  }}
                />
              )}
          </div>
        )}
        {!loading && !tooLarge && codeLines && mode === 'preview' && (
          <div className={styles.codeView}>
            {codeLines.map((text, i) => (
              <div
                key={i}
                ref={i + 1 === line ? highlightRef : undefined}
                className={`${styles.codeLine} ${i + 1 === line ? styles.lineHighlight : ''}`}
              >
                <span className={styles.lineNum}>{i + 1}</span>
                {highlighted
                  ? (
                    // hljs output — the source is escaped by the highlighter,
                    // pinned by the injection test in highlightLines.test.ts.
                    <span
                      className={styles.lineText}
                      dangerouslySetInnerHTML={{ __html: highlighted[i] ?? '' }}
                    />
                  )
                  : <span className={styles.lineText}>{text}</span>}
              </div>
            ))}
          </div>
        )}
        {!loading && !tooLarge && !isImage && !hasLineView && mode === 'preview' && isMarkdown && (
          <div
            className={styles.markdownContent}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
        {!loading && !tooLarge && !isImage && mode === 'edit' && (
          <textarea
            className={styles.editTextarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
