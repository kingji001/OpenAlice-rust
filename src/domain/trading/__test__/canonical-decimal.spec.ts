import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { toCanonicalDecimalString, CanonicalDecimalError } from '../canonical-decimal.js'

describe('toCanonicalDecimalString', () => {
  it.each([
    [new Decimal('0'), '0'],
    [new Decimal('-0'), '0'],
    [new Decimal('1'), '1'],
    [new Decimal('-1'), '-1'],
    [new Decimal('1.5'), '1.5'],
    [new Decimal('1.50'), '1.5'],
    [new Decimal('1.500000'), '1.5'],
    [new Decimal('100'), '100'],
    [new Decimal('100.000'), '100'],
    [new Decimal('1e30'), '1000000000000000000000000000000'],
    [new Decimal('1e-30'), '0.000000000000000000000000000001'],
    [new Decimal('0.000000001'), '0.000000001'],
    [new Decimal('0.123456789012345678'), '0.123456789012345678'],
    [new Decimal('170141183460469231731687303715884105727'),
      '170141183460469231731687303715884105727'],
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(toCanonicalDecimalString(input)).toBe(expected)
  })

  it('rejects NaN', () => {
    expect(() => toCanonicalDecimalString(new Decimal(NaN))).toThrow(CanonicalDecimalError)
  })

  it('rejects positive Infinity', () => {
    expect(() => toCanonicalDecimalString(new Decimal(Infinity))).toThrow(CanonicalDecimalError)
  })

  it('rejects negative Infinity', () => {
    expect(() => toCanonicalDecimalString(new Decimal(-Infinity))).toThrow(CanonicalDecimalError)
  })
})
