import React, { useEffect, useState } from 'react';

interface Props {
  /** `settings.agentSpeechMuted` from the snapshot. */
  muted: boolean;
  className?: string;
}

export function setAgentSpeechMuted(muted: boolean): Promise<Response> {
  return fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentSpeechMuted: muted }),
  });
}

/** Header button: mute agents' voice. While muted, the `say` shim prints the
 *  text and adds it to the session's conversation instead of speaking. */
export function AgentVoiceToggle({ muted, className }: Props) {
  // Optimistic until the snapshot carries the new value.
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => { setPending(null); }, [muted]);
  const on = pending ?? muted;
  const label = on ? "Agents' voice muted — click to unmute" : "Mute agents' voice (say)";

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const next = !on;
        setPending(next);
        void setAgentSpeechMuted(next).then(r => { if (!r.ok) setPending(null); }, () => setPending(null));
      }}
      title={on ? "Agents' voice is muted: what they say shows in the conversation. Click to unmute." : "Mute agents' voice: what they say shows in the conversation instead"}
      aria-label={label}
      aria-pressed={on}
      data-muted={on || undefined}
    >
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden>
        <path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        {on ? (
          <path d="M11 6l3.5 4M14.5 6L11 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : (
          <path d="M11 5.5c.9.7 1.4 1.5 1.4 2.5s-.5 1.8-1.4 2.5M12.8 3.8c1.4 1.1 2.2 2.5 2.2 4.2s-.8 3.1-2.2 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}
