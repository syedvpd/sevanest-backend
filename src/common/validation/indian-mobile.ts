import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

/** Accepts 10 digits starting 6-9, optionally prefixed with +91, 91 or 0 (FRD FM-01: "valid Indian mobile number"). */
const INDIAN_MOBILE_INPUT = /^(?:\+91|91|0)?([6-9][0-9]{9})$/;
const E164_INDIAN_MOBILE = /^\+91[6-9][0-9]{9}$/;

/** Canonical stored form: E.164, e.g. +919876543210. Returns null when the input is not a valid Indian mobile. */
export function normalizeIndianMobile(raw: string): string | null {
  const match = INDIAN_MOBILE_INPUT.exec(raw.trim());
  return match ? `+91${match[1]}` : null;
}

/** For routine admin screens (FR-SEC-006): keeps the country code and the last four digits. */
export function maskMobile(e164: string | null | undefined): string | null {
  if (!e164) {
    return null;
  }
  return `${e164.slice(0, 3)}${'*'.repeat(Math.max(e164.length - 7, 0))}${e164.slice(-4)}`;
}

/**
 * DTO decorator: normalises the input to E.164 first (class-transformer runs before validation), then requires a valid
 * Indian mobile. Services therefore only ever see the canonical form.
 */
export function IsIndianMobile(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? (normalizeIndianMobile(value) ?? value) : value,
    )(target, propertyKey);
    registerDecorator({
      name: 'isIndianMobile',
      target: target.constructor,
      propertyName: String(propertyKey),
      options: { message: 'must be a valid Indian mobile number', ...options },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && E164_INDIAN_MOBILE.test(value),
      },
    });
  };
}
