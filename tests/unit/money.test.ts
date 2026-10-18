import { describe, expect, it } from 'vitest';
import { allocateMinor, commissionMinor, certificateRelease, payrollTotal } from '../../src/domain/money';

describe('integer money rules', () => {
  it('distributes every kopeck proportionally and deterministically', () => {
    expect(allocateMinor(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateMinor(690000, [300000, 390000])).toEqual([300000, 390000]);
    expect(allocateMinor(0, [0, 0])).toEqual([0, 0]);
  });
  it('calculates commission after discount and actual materials with half-up rounding', () => {
    expect(commissionMinor(300000, 30000, 50000, 4000)).toBe(88000);
    expect(commissionMinor(101, 0, 0, 5000)).toBe(51);
    expect(commissionMinor(100, 0, 200, 4000)).toBe(0);
  });
  it('releases discounted certificate liability with no rounding residue on final redemption', () => {
    expect(certificateRelease(300, 200, 100)).toBe(67);
    expect(certificateRelease(200, 133, 200)).toBe(133);
    expect(() => certificateRelease(200, 133, 201)).toThrow();
  });
  it('distinguishes total and variable guarantees', () => {
    expect(payrollTotal(800000, 900000, 1000000, 'total')).toBe(1700000);
    expect(payrollTotal(800000, 900000, 1000000, 'variable')).toBe(1800000);
  });
  it('rejects unsafe and fractional monetary inputs', () => {
    expect(() => allocateMinor(1.5, [1])).toThrow();
    expect(() => commissionMinor(Number.MAX_SAFE_INTEGER + 1, 0, 0, 4000)).toThrow();
    expect(() => allocateMinor(1, [0])).toThrow();
  });
});
