export function normalizePath(p: string): string {
  // Convert WSL path /mnt/c/... to c:/...
  const wslMatch = p.match(/^\/mnt\/([a-z])\/(.*)/i);
  if (wslMatch) return `${wslMatch[1]}:/${wslMatch[2]}`.toLowerCase();
  // Normalize backslashes and lowercase
  return p.replace(/\\/g, '/').toLowerCase();
}
