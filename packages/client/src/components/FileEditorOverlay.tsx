import React, { useEffect, useState, useRef, useCallback } from 'react';
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

interface Props {
  path: string;
  cwd?: string;
  onClose: () => void;
}

type Mode = 'preview' | 'edit';

export function FileEditorOverlay({ path, cwd, onClose }: Props) {
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
  const isDirty = content !== original;

  useEffect(() => {
    setLoading(true);
    setTooLarge(false);
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (r.status === 413) { setTooLarge(true); setLoading(false); return; }
        if (!r.ok) { setSaveError(`Error ${r.status}`); setLoading(false); return; }
        const data = await r.json() as { content: string; writable: boolean };
        setContent(data.content);
        setOriginal(data.content);
        setWritable(data.writable);
        if (!isMarkdown) setMode('edit');
        setLoading(false);
      })
      .catch((err) => { setSaveError(String(err)); setLoading(false); });
  }, [path, isMarkdown]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError('');
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
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
  }, [path, content]);

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

  const displayPath = cwd && path.startsWith(cwd + '/')
    ? path.slice(cwd.length + 1)
    : path;

  const dirPart = displayPath.includes('/') ? displayPath.slice(0, displayPath.lastIndexOf('/') + 1) : '';
  const filePart = displayPath.slice(dirPart.length);

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.filePath}>
            {dirPart}<span>{filePart}</span>
          </div>
          <div className={styles.controls}>
            {isMarkdown && (
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
            <button
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={!isDirty || !writable || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
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
          {!loading && !tooLarge && mode === 'preview' && isMarkdown && (
            <div
              className={styles.markdownContent}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          )}
          {!loading && !tooLarge && mode === 'edit' && (
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
