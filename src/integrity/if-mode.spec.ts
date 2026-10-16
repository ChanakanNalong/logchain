import { readIfMode } from './if-mode';

describe('readIfMode', () => {
  it('defaults to active when unset or empty', () => {
    expect(readIfMode({})).toBe('active');
    expect(readIfMode({ IF_MODE: '' })).toBe('active');
    expect(readIfMode({ IF_MODE: '  ' })).toBe('active');
  });

  it('accepts active / calibrating, case-insensitive and trimmed', () => {
    expect(readIfMode({ IF_MODE: 'active' })).toBe('active');
    expect(readIfMode({ IF_MODE: 'calibrating' })).toBe('calibrating');
    expect(readIfMode({ IF_MODE: ' CALIBRATING ' })).toBe('calibrating');
  });

  it('throws on an unknown value (fail loud, not silently active)', () => {
    expect(() => readIfMode({ IF_MODE: 'on' })).toThrow(/IF_MODE/);
  });
});
