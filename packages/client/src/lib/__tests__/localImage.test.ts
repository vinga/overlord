import { describe, it, expect } from 'vitest';
import { isImagePath, localImageSrc } from '../localImage';

describe('localImageSrc', () => {
  it('routes an absolute path through the file endpoint', () => {
    expect(localImageSrc('/tmp/shot.png')).toBe('/api/file-raw?path=%2Ftmp%2Fshot.png');
  });

  it('decodes file:// URLs', () => {
    expect(localImageSrc('file:///Users/a/my%20shot.JPG')).toBe(
      `/api/file-raw?path=${encodeURIComponent('/Users/a/my shot.JPG')}`,
    );
  });

  it('accepts Windows paths, plain and as file:// URLs', () => {
    expect(localImageSrc('C:\\tmp\\a.webp')).toBe(`/api/file-raw?path=${encodeURIComponent('C:\\tmp\\a.webp')}`);
    expect(localImageSrc('file:///C:/tmp/a.gif')).toBe(`/api/file-raw?path=${encodeURIComponent('C:/tmp/a.gif')}`);
  });

  it('leaves web, relative, home and protocol-relative sources alone', () => {
    expect(localImageSrc('https://example.com/a.png')).toBeNull();
    expect(localImageSrc('docs/a.png')).toBeNull();
    expect(localImageSrc('~/a.png')).toBeNull();
    expect(localImageSrc('//cdn.example.com/a.png')).toBeNull();
  });

  it('rejects non-image extensions', () => {
    expect(localImageSrc('/etc/passwd')).toBeNull();
    expect(localImageSrc('/tmp/a.png.txt')).toBeNull();
  });
});

describe('isImagePath', () => {
  it('matches image extensions case-insensitively', () => {
    expect(isImagePath('/a/b.SVG')).toBe(true);
    expect(isImagePath('/a/b.ts')).toBe(false);
  });
});
