import { describe, expect, it } from 'vitest';
import { parseRepo } from '../src/types';

describe('parseRepo', () => {
  it('parses a valid owner/name', () => {
    expect(parseRepo('acme/widgets')).toEqual({ owner: 'acme', name: 'widgets' });
    expect(parseRepo('a-b.c_d/e.f-g')).toEqual({ owner: 'a-b.c_d', name: 'e.f-g' });
  });

  it('rejects shell metacharacters (injection guard)', () => {
    expect(() => parseRepo('acme/widgets; rm -rf /')).toThrow();
    expect(() => parseRepo('x$(evil)/y')).toThrow();
    expect(() => parseRepo('a b/c')).toThrow();
    expect(() => parseRepo('acme/wid`gets`')).toThrow();
  });

  it('rejects malformed slugs', () => {
    expect(() => parseRepo('noslash')).toThrow();
    expect(() => parseRepo('a/b/c')).toThrow();
    expect(() => parseRepo('/x')).toThrow();
  });
});
