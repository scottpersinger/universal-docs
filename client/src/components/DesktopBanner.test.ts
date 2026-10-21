import { describe, expect, it } from 'vitest';
import { shortPath } from './DesktopBanner.tsx';

describe('shortPath', () => {
  it('shows the home folder as ~', () => {
    expect(shortPath('/Users/scott/Documents/Q3')).toBe('~/Documents/Q3');
    expect(shortPath('/Users/scott')).toBe('~');
    expect(shortPath('/home/scott/notes')).toBe('~/notes');
    expect(shortPath('C:\\Users\\scott\\Docs')).toBe('~\\Docs');
    expect(shortPath('/Users/scottish-folder-elsewhere')).toBe('~');
    expect(shortPath('/Volumes/Data/Q3')).toBe('/Volumes/Data/Q3');
  });
});
