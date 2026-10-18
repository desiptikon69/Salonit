import { describe, expect, it } from 'vitest';
import manifest from '../../src/app/manifest';

const data = manifest();
const icons = data.icons ?? [];

describe('installable web app manifest', () => {
  it('launches standalone from the site root', () => {
    expect(data.id).toBe('/');
    expect(data.start_url).toBe('/');
    expect(data.scope).toBe('/');
    expect(data.display).toBe('standalone');
    expect(data.theme_color).toBe('#f6f4ef');
    expect(data.background_color).toBe('#f6f4ef');
  });

  it('ships both standard and maskable 192/512 icons', () => {
    for (const size of ['192x192', '512x512']) {
      expect(icons).toContainEqual(expect.objectContaining({ sizes: size, purpose: 'any', type: 'image/png' }));
      expect(icons).toContainEqual(expect.objectContaining({ sizes: size, purpose: 'maskable', type: 'image/png' }));
    }
  });

  it('offers install screenshots and booking shortcuts', () => {
    expect(data.screenshots?.map((shot) => shot.form_factor)).toEqual(['narrow', 'wide']);
    expect(data.shortcuts?.map((shortcut) => shortcut.url)).toEqual(['/book', '/account']);
  });
});
