import { useEffect, useRef, useState } from 'react';
import styles from './RoomDetailsTab.module.css';

interface Props {
  cwd: string;
}

export function RoomDetailsTab({ cwd }: Props) {
  const [prefix, setPrefix] = useState('');
  const [prefixInitial, setPrefixInitial] = useState('');
  const [description, setDescription] = useState('');
  const [descriptionInitial, setDescriptionInitial] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch(`/api/room-config?cwd=${encodeURIComponent(cwd)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ prefix: string; description: string }>;
      })
      .then(cfg => {
        if (cancelled) return;
        setPrefix(cfg.prefix ?? '');
        setPrefixInitial(cfg.prefix ?? '');
        setDescription(cfg.description ?? '');
        setDescriptionInitial(cfg.description ?? '');
        setLoaded(true);
      })
      .catch(err => { if (!cancelled) { setError(String(err)); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [cwd]);

  const dirty = prefix !== prefixInitial || description !== descriptionInitial;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/room-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, prefix, description }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPrefixInitial(prefix);
      setDescriptionInitial(description);
      setSavedAt(Date.now());
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="room-description">Description</label>
        <textarea
          id="room-description"
          ref={descriptionRef}
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this room for?"
          rows={8}
          disabled={!loaded}
          spellCheck={false}
        />
        <span className={styles.hint}>
          The first line is shown as a subtitle under the room name. If empty, nothing is shown.
        </span>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="room-prefix">Session prefix</label>
        <input
          id="room-prefix"
          type="text"
          className={styles.input}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="(none)"
          disabled={!loaded}
          spellCheck={false}
        />
        <span className={styles.hint}>
          Pre-filled in the new-session name dialog for this room — you can still edit before spawning.
        </span>
      </div>
      {error && <span className={styles.error}>{error}</span>}
      <div className={styles.actions}>
        {savedAt && !dirty && !saving && <span className={styles.saved}>Saved</span>}
        <button
          className={styles.saveBtn}
          onClick={handleSave}
          disabled={!loaded || saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
