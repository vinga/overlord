import React from 'react';
import type { AdfNode } from '../../types';
import styles from './AdfView.module.css';

// Minimal Atlassian Document Format renderer for the Jira hover card. Builds
// React elements only (no innerHTML). Unknown nodes fall back to their
// children, so new ADF types degrade to plain text instead of vanishing.

function safeHref(v: unknown): string | undefined {
  return typeof v === 'string' && /^(https?:|mailto:)/i.test(v) ? v : undefined;
}

function attr(n: AdfNode, k: string): unknown {
  return n.attrs?.[k];
}

function renderText(n: AdfNode, key: React.Key): React.ReactNode {
  let el: React.ReactNode = n.text ?? '';
  for (const m of n.marks ?? []) {
    switch (m.type) {
      case 'strong': el = <strong>{el}</strong>; break;
      case 'em': el = <em>{el}</em>; break;
      case 'code': el = <code className={styles.code}>{el}</code>; break;
      case 'strike': el = <s>{el}</s>; break;
      case 'underline': el = <u>{el}</u>; break;
      case 'link': {
        const href = safeHref(m.attrs?.href);
        if (href) el = <a href={href} target="_blank" rel="noopener noreferrer">{el}</a>;
        break;
      }
      default: break;
    }
  }
  return <React.Fragment key={key}>{el}</React.Fragment>;
}

function children(n: AdfNode): React.ReactNode {
  return n.content?.map((c, i) => renderNode(c, i));
}

function renderNode(n: AdfNode, key: React.Key): React.ReactNode {
  switch (n.type) {
    case 'doc': return <React.Fragment key={key}>{children(n)}</React.Fragment>;
    case 'text': return renderText(n, key);
    case 'paragraph': return <p key={key}>{children(n)}</p>;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attr(n, 'level')) || 3));
      return <div key={key} className={styles.heading} data-level={level}>{children(n)}</div>;
    }
    case 'bulletList': return <ul key={key}>{children(n)}</ul>;
    case 'orderedList': return <ol key={key} start={Number(attr(n, 'order')) || undefined}>{children(n)}</ol>;
    case 'listItem': return <li key={key}>{children(n)}</li>;
    case 'taskList': return <ul key={key} className={styles.tasks}>{children(n)}</ul>;
    case 'taskItem': return <li key={key} data-state={String(attr(n, 'state') ?? '')}>{children(n)}</li>;
    case 'codeBlock': return <pre key={key} className={styles.pre}><code>{children(n)}</code></pre>;
    case 'blockquote': return <blockquote key={key}>{children(n)}</blockquote>;
    case 'panel': return <div key={key} className={styles.panel} data-panel={String(attr(n, 'panelType') ?? 'info')}>{children(n)}</div>;
    case 'rule': return <hr key={key} />;
    case 'hardBreak': return <br key={key} />;
    case 'mention': return <span key={key} className={styles.mention}>{String(attr(n, 'text') ?? '@someone')}</span>;
    case 'emoji': return <React.Fragment key={key}>{String(attr(n, 'text') ?? attr(n, 'shortName') ?? '')}</React.Fragment>;
    case 'status': return <span key={key} className={styles.status}>{String(attr(n, 'text') ?? '')}</span>;
    case 'date': {
      const ts = Number(attr(n, 'timestamp'));
      return <React.Fragment key={key}>{Number.isFinite(ts) ? new Date(ts).toLocaleDateString() : ''}</React.Fragment>;
    }
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const href = safeHref(attr(n, 'url'));
      return href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{href}</a> : null;
    }
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
    case 'media':
      return <span key={key} className={styles.media}>📎 attachment</span>;
    case 'table': return <div key={key} className={styles.tableWrap}><table><tbody>{children(n)}</tbody></table></div>;
    case 'tableRow': return <tr key={key}>{children(n)}</tr>;
    case 'tableHeader': return <th key={key}>{children(n)}</th>;
    case 'tableCell': return <td key={key}>{children(n)}</td>;
    default: return <React.Fragment key={key}>{children(n)}</React.Fragment>;
  }
}

/** True when the ADF tree holds no visible text or media. */
export function adfIsEmpty(n: AdfNode | undefined): boolean {
  if (!n) return true;
  if (n.type === 'text') return !n.text?.trim();
  if (['media', 'mediaSingle', 'mediaGroup', 'mediaInline', 'mention', 'emoji', 'inlineCard', 'blockCard', 'rule', 'status'].includes(n.type)) return false;
  return (n.content ?? []).every(adfIsEmpty);
}

export function AdfView({ doc, className }: { doc: AdfNode; className?: string }) {
  return <div className={`${styles.adf} ${className ?? ''}`}>{renderNode(doc, 0)}</div>;
}
