import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { marked } from 'marked';
import styles from './FileEditorOverlay.module.css';

marked.use({
  hooks: {
    postprocess(html: string) {
      return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    },
  },
});

const markdownCache = new Map<string, string>();
function renderMarkdown(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, { breaks: true, async: false }) as string;
  if (markdownCache.size > 200) markdownCache.clear();
  markdownCache.set(text, html);
  return html;
}

const FILE_EDITOR_MODE_KEY = 'overlord:fileEditorMode';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTS.has(p.slice(dot + 1).toLowerCase());
}

interface Props {
  path: string;
  line?: number;
  cwd?: string;
  onClose: () => void;
}

type Mode = 'preview' | 'edit';

export function FileEditorOverlay({ path, line, cwd, onClose }: Props) {
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
  // A line reference gets a numbered read-only code view (even for markdown —
  // rendered-markdown lines don't map back to source lines).
  const hasLineView = line !== undefined && !isImage;
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Repo-relative references (`/src/File.tsx`) 404 as-is; retry against the
  // session cwd. `inferred` drives a visible warning — the viewer is then
  // showing a guess, not the literal path that was clicked.
  const [effective, setEffective] = useState<{ path: string; inferred: boolean }>({ path, inferred: false });
  useEffect(() => { setEffective({ path, inferred: false }); }, [path, cwd]);
  const cwdCandidate = cwd && !path.startsWith(cwd)
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
    let cancelled = false;
    (async () => {
      try {
        let r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        let used = { path, inferred: false };
        if (r.status === 404 && cwdCandidate) {
          const retry = await fetch(`/api/file?path=${encodeURIComponent(cwdCandidate)}`);
          if (retry.ok || retry.status === 413) {
            r = retry;
            used = { path: cwdCandidate, inferred: true };
          }
        }
        if (cancelled) return;
        setEffective(used);
        if (r.status === 413) { setTooLarge(true); setLoading(false); return; }
        if (!r.ok) { setSaveError(`Error ${r.status}`); setLoading(false); return; }
        const data = await r.json() as { content: string; writable: boolean };
        setContent(data.content);
        setOriginal(data.content);
        setWritable(data.writable);
        if (line !== undefined) setMode('preview');
        else if (!isMarkdown) setMode('edit');
        setLoading(false);
      } catch (err) {
        if (!cancelled) { setSaveError(String(err)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [path, isMarkdown, isImage, line, cwdCandidate]);

  useEffect(() => {
    if (!loading && mode === 'preview' && hasLineView) {
      highlightRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [loading, mode, hasLineView, line, path]);

  const codeLines = useMemo(
    () => (hasLineView && !loading ? content.split('\n') : null),
    [hasLineView, loading, content],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError('');
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: effective.path, content }),
      });
      if (r.status === 403) { setSaveError('File is read-only'); setSaving(false); return; }
      if (!r.ok) { setSaveError(`Error ${r.status}`); setSaving(false); return; }
      setOriginal(content);
      setSaveFlash('Saved');
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setSaveFlash(''), 2000);
    } catch (err) {
      setSaveError(String(err));
    }
    setSaving(false);
  }, [effective.path, content]);

  const handleClose = useCallback(() => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [isDirty, onClose]);

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  }, [handleClose]);

  const handleModeChange = useCallback((m: Mode) => {
    setMode(m);
    localStorage.setItem(FILE_EDITOR_MODE_KEY, m);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleClose]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const displayPath = cwd && effective.path.startsWith(cwd + '/')
    ? effective.path.slice(cwd.length + 1)
    : effective.path;

  const dirPart = displayPath.includes('/') ? displayPath.slice(0, displayPath.lastIndexOf('/') + 1) : '';
  const filePart = displayPath.slice(dirPart.length);

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.modal}>
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
            {(isMarkdown || hasLineView) && (
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
            <button className={styles.closeBtn} onClick={handleClose} title="Close (Esc)">✕</button>
          </div>
        </div>

        <div className={styles.body}>
          {loading && <div className={styles.loading}>Loading…</div>}
          {tooLarge && (
            <div className={styles.tooLarge}>
              <span>File too large to edit inline (&gt;1MB)</span>
              <button
                className={styles.openIdeBtn}
                onClick={() => {
                  void fetch('/api/open-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
                }}
              >Open in IDE</button>
            </div>
          )}
          {!loading && isImage && (
            <div className={styles.imageWrap}>
              {saveError
                ? <span className={styles.saveError}>{saveError}</span>
                : (
                  <img
                    className={styles.imageView}
                    src={`/api/file-raw?path=${encodeURIComponent(effective.path)}`}
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
                  <span className={styles.lineText}>{text}</span>
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
    </div>
  );
}
