import { describe, it, expect } from 'vitest'
import { canonicalJson } from './_canonical-json.js'

describe('canonicalJson', () => {
  it('sorts object keys alphabetically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested object keys', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}')
  })

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('sorts keys inside arrays of objects', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  it('handles primitives', () => {
    expect(canonicalJson('hello')).toBe('"hello"')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
  })

  it('pretty mode uses 2-space indent', () => {
    expect(canonicalJson({ b: 1, a: 2 }, { pretty: true })).toBe(
      '{\n  "a": 2,\n  "b": 1\n}',
    )
  })

  it('round-trips: parse(canonical(x)) deep-equals x', () => {
    const x = { z: [{ b: 2, a: 1 }, { d: 4, c: 3 }], a: 'first' }
    expect(JSON.parse(canonicalJson(x))).toEqual(x)
  })
})
