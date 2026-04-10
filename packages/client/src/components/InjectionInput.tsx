import { useState, useRef, useEffect } from 'react';
import styles from './InjectionInput.module.css';

interface PastedImage {
  path: string;
  previewUrl: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface InjectionInputProps {
  sessionId: string;
  lastMessages: Message[];
  onSend: (text: string) => void;
  error?: string;
  connected: boolean;
}

export function InjectionInput({
  sessionId,
  lastMessages,
  onSend,
  error,
  connected,
}: InjectionInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [localSent, setLocalSent] = useState<Message[]>([]);
  const [pastedImage, setPastedImage] = useState<PastedImage | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear local sent messages when session changes
  useEffect(() => { setLocalSent([]); }, [sessionId]);

  // Merge lastMessages (from JSONL) with locally-sent messages.
  // Local sent messages fill the gap before the JSONL round-trip completes.
  // Once lastMessages contains the user message we de-duplicate by content.
  const knownUserContents = new Set(
    lastMessages.filter(m => m.role === 'user').map(m => m.content)
  );
  const pendingLocal = localSent.filter(m => !knownUserContents.has(m.content));

  // Build merged list: interleave local sent into lastMessages in order
  const merged: Message[] = [...lastMessages];
  for (const local of pendingLocal) {
    // Insert before the first assistant message that arrived after we sent
    merged.push(local);
  }

  // Scroll to bottom whenever messages change
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [merged.length]);

  // Clear confirm timer on unmount
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  function handleSend() {
    const trimmed = inputValue.trim();
    if (!trimmed && !pastedImage) return;
    if (!connected) return;
    const text = pastedImage ? `${trimmed} @${pastedImage.path}`.trim() : trimmed;
    onSend(text);
    setLocalSent(prev => [...prev, { role: 'user', content: text }]);
    setInputValue('');
    setPastedImage(null);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return; // let normal text paste proceed

    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      const ext = imageItem.type === 'image/png' ? 'png' : 'jpg';

      const res = await fetch('/api/paste-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, ext }),
      });
      const { path, previewUrl } = await res.json() as PastedImage;
      setPastedImage({ path, previewUrl });
    };
    reader.readAsDataURL(blob);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setInputValue('');
    }
  }

  return (
    <div className={styles.container}>
      {/* Message history */}
      <div className={styles.transcript} ref={transcriptRef}>
        {merged.length === 0 ? (
          <div className={styles.emptyState}>No recent messages.</div>
        ) : (
          merged.map((msg, i) => (
            <div
              key={i}
              className={`${styles.message} ${msg.role === 'user' ? styles.messageUser : styles.messageAssistant}`}
            >
              <span className={styles.messageRole}>
                {msg.role === 'user' ? 'you' : 'claude'}
              </span>
              <span className={styles.messageContent}>{msg.content.slice(0, 500)}</span>
            </div>
          ))
        )}
      </div>

      {/* Error banner */}
      {error && <div className={styles.error}>{error}</div>}

      {/* Image preview */}
      {pastedImage && (
        <div className={styles.imagePreview}>
          <img src={pastedImage.previewUrl} alt="pasted" />
          <button onClick={() => setPastedImage(null)} className={styles.removeImage}>✕</button>
        </div>
      )}

      {/* Input row */}
      <div className={styles.inputRow}>
        <textarea
          className={styles.textarea}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={connected ? 'Type a message… (Enter to send, Shift+Enter for newline)' : 'Not connected'}
          disabled={!connected}
          rows={3}
        />
        <button
          className={styles.sendButton}
          onClick={handleSend}
          disabled={!connected || (!inputValue.trim() && !pastedImage)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
