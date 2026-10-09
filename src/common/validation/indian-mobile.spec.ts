import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IsIndianMobile, maskMobile, normalizeIndianMobile } from './indian-mobile';

class Dto {
  @IsIndianMobile()
  mobile!: string;
}

const validate = (mobile: unknown) => {
  const dto = plainToInstance(Dto, { mobile });
  return { dto, errors: validateSync(dto) };
};

describe('normalizeIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['  6000000000 ', '+916000000000'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each([
    '5876543210', // must start 6-9
    '987654321', // 9 digits
    '98765432101', // 11 digits
    '+449876543210',
    '98765 43210',
    '98765-43210',
    '',
    'abcdefghij',
  ])('rejects %s', (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });
});

describe('IsIndianMobile', () => {
  it('normalises first, then validates, so services only see E.164', () => {
    const { dto, errors } = validate('09876543210');
    expect(errors).toHaveLength(0);
    expect(dto.mobile).toBe('+919876543210');
  });

  it.each([123, null, undefined, {}, ['9876543210'], 'nope'])(
    'rejects non-mobile input %p',
    (input) => {
      expect(validate(input).errors).toHaveLength(1);
    },
  );
});

describe('maskMobile', () => {
  it('keeps the country code and last four digits', () => {
    expect(maskMobile('+919876543210')).toBe('+91******3210');
  });
  it('passes null through', () => {
    expect(maskMobile(null)).toBeNull();
    expect(maskMobile(undefined)).toBeNull();
  });
});
