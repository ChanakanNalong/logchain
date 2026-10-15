import { divInt, formatDec, fromUnits, mul, mulInt, parseDec } from './decimal';

describe('exact decimal helpers', () => {
  it('parses decimal strings and rejects anything else', () => {
    expect(parseDec('0.0000625')).toEqual({ int: 625n, scale: 7 });
    expect(parseDec(' 7.85 ')).toEqual({ int: 785n, scale: 2 });
    expect(parseDec('12')).toEqual({ int: 12n, scale: 0 });
    for (const bad of ['', undefined, null, '1e-7', '-1', 'abc', '1.', '.5']) {
      expect(parseDec(bad)).toBeNull();
    }
  });

  it('formats without exponent and trims trailing zeros', () => {
    expect(formatDec(fromUnits(3_907_800_000_000_000n, 18))).toBe('0.0039078');
    expect(formatDec(fromUnits(50_000_000_000n, 9))).toBe('50');
    expect(formatDec(fromUnits(1n, 18))).toBe('0.000000000000000001');
    expect(formatDec({ int: 0n, scale: 5 })).toBe('0');
  });

  it('multiplies and divides exactly', () => {
    const pol = fromUnits(78156n * 50_000_000_000n, 18);
    expect(formatDec(pol)).toBe('0.0039078');
    expect(formatDec(divInt(pol, 5n))).toBe('0.00078156');
    expect(formatDec(mulInt(pol, 5n))).toBe('0.019539');
    expect(formatDec(mul(pol, parseDec('7.85')!))).toBe('0.03067623');
    expect(formatDec(mul(pol, parseDec('0.0000625')!))).toBe('0.0000002442375');
    // หารไม่ลงตัว — ปัดลงที่ 12 ตำแหน่งเพิ่ม ไม่มีทศนิยมยาวไม่จบ / ไม่มี float
    expect(formatDec(divInt(fromUnits(1n, 0), 3n))).toBe('0.333333333333');
  });
});
