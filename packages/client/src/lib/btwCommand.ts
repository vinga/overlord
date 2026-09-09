/** `/btw <text>` typed into the header search box — parse it out, or null. */
export const BTW_PREFIX = '/btw';

export function parseBtwCommand(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(BTW_PREFIX)) return null;
  const rest = trimmed.slice(BTW_PREFIX.length);
  // Require a separator so "/btwx" isn't treated as a command.
  if (rest.length > 0 && !/^\s/.test(rest)) return null;
  const text = rest.trim();
  return text.length > 0 ? text : null;
}

/** True while the user is typing a /btw command (even before any question text). */
export function isBtwDraft(input: string): boolean {
  const t = input.trimStart().toLowerCase();
  return t === BTW_PREFIX || t.startsWith(BTW_PREFIX + ' ');
}
