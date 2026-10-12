import { buildSampleFile, matchesDeclaredType, validateContent } from './file-signature';

describe('KYC file signature check', () => {
  const pdf = Buffer.from('%PDF-1.4\n');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

  it('accepts a matching signature for each supported type', () => {
    expect(matchesDeclaredType('application/pdf', pdf)).toBe(true);
    expect(matchesDeclaredType('image/jpeg', jpeg)).toBe(true);
    expect(matchesDeclaredType('image/png', png)).toBe(true);
  });

  it('rejects a payload declared as another type', () => {
    expect(matchesDeclaredType('application/pdf', jpeg)).toBe(false);
    expect(matchesDeclaredType('image/png', pdf)).toBe(false);
    expect(matchesDeclaredType('image/jpeg', Buffer.from('<html>'))).toBe(false);
  });

  it('fails closed for an empty, truncated or unknown type', () => {
    expect(matchesDeclaredType('application/pdf', Buffer.alloc(0))).toBe(false);
    expect(matchesDeclaredType('image/png', png.subarray(0, 4))).toBe(false);
    expect(matchesDeclaredType('image/gif', Buffer.from('GIF89a'))).toBe(false);
    expect(matchesDeclaredType('text/html', Buffer.from('<html>'))).toBe(false);
  });
});

describe('whole-file content validation', () => {
  it.each(['application/pdf', 'image/jpeg', 'image/png'])(
    'accepts a well-formed %s of any realistic size',
    (type) => {
      for (const size of [24, 1000, 5_000_000]) {
        expect(validateContent(type, buildSampleFile(type, size))).toEqual({ ok: true });
      }
    },
  );

  it.each(['application/pdf', 'image/jpeg', 'image/png'])(
    'refuses a %s that was cut short in transit',
    (type) => {
      const whole = buildSampleFile(type, 2000);
      expect(validateContent(type, whole.subarray(0, 1000))).toEqual({
        ok: false,
        reason: 'TRUNCATED',
      });
      expect(validateContent(type, whole.subarray(0, 4))).toMatchObject({ ok: false });
    },
  );

  it('refuses empty files, spoofed types and markup labelled as an image or PDF', () => {
    expect(validateContent('image/png', Buffer.alloc(0))).toEqual({ ok: false, reason: 'EMPTY' });
    expect(validateContent('image/png', buildSampleFile('application/pdf', 500))).toEqual({
      ok: false,
      reason: 'SIGNATURE',
    });
    for (const type of ['application/pdf', 'image/jpeg', 'image/png']) {
      expect(validateContent(type, Buffer.from('<html><script>alert(1)</script></html>'))).toEqual({
        ok: false,
        reason: 'SIGNATURE',
      });
    }
    expect(validateContent('image/svg+xml', Buffer.from('<svg/>'))).toMatchObject({ ok: false });
  });

  it('refuses a bare signature followed by junk', () => {
    expect(
      validateContent(
        'application/pdf',
        Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(50, 0x41)]),
      ),
    ).toEqual({ ok: false, reason: 'TRUNCATED' });
  });
});
