/**
 * Local image references in the chat feed. The browser cannot load a bare
 * filesystem path, so absolute paths and `file://` URLs are routed through
 * `/api/file-raw`, which scopes them to the allowed roots server-side.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p);
}

/** Endpoint URL for a local image, or null when `src` is not one (web URLs, relative and `~` paths). */
export function localImageSrc(src: string): string | null {
  let path = src.trim();
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
    // file:///C:/x.png → pathname "/C:/x.png"
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  if (!isAbsolute || path.startsWith('//') || !isImagePath(path)) return null;
  return `/api/file-raw?path=${encodeURIComponent(path)}`;
}
