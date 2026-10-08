import { ArgumentMetadata } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { DomainException } from '../errors/domain.exception';
import { createValidationPipe } from './validation.pipe';

class AddressDto {
  @IsString()
  city!: string;
}

class SampleDto {
  @IsString()
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  count!: number;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;
}

const metadata: ArgumentMetadata = { type: 'body', metatype: SampleDto };

describe('createValidationPipe', () => {
  const pipe = createValidationPipe();

  it('transforms and strips unknown fields', async () => {
    const result = (await pipe.transform(
      { name: 'a', count: '3', address: { city: 'Hyderabad' }, isAdmin: true },
      metadata,
    )) as SampleDto;
    expect(result).toBeInstanceOf(SampleDto);
    expect(result.count).toBe(3);
    expect(result).not.toHaveProperty('isAdmin');
  });

  it('returns VALIDATION_FAILED with per-field details and never echoes submitted values', async () => {
    const attempt = pipe.transform(
      { name: 42, count: 0, address: { city: 7 }, secret: 'leak-me' },
      metadata,
    );
    await expect(attempt).rejects.toBeInstanceOf(DomainException);
    const error = (await attempt.catch((e: unknown) => e)) as DomainException;
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    const fields = (error.details ?? []).map((d) => d.field).sort();
    expect(fields).toEqual(['address.city', 'count', 'name']);
    expect(JSON.stringify(error.details)).not.toContain('leak-me');
  });
});
