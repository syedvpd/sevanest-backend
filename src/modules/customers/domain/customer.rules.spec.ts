import { DomainException } from '../../../common/errors/domain.exception';
import { assertCoordinatePair } from './customer.rules';

function details(fn: () => void): Array<{ field: string; messages: string[] }> | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainException) {
      return error.details;
    }
    throw error;
  }
  return undefined;
}

describe('assertCoordinatePair', () => {
  it.each([
    [undefined, undefined],
    [null, null],
    [17.4, 78.3],
    [0, 0], // 0 is a real coordinate, not "missing"
  ])('accepts %p / %p', (lat, lng) => {
    expect(() => assertCoordinatePair(lat, lng)).not.toThrow();
  });

  it.each([
    [17.4, undefined],
    [17.4, null],
    [undefined, 78.3],
    [null, 78.3],
  ])('rejects half-set coordinates %p / %p', (lat, lng) => {
    expect(() => assertCoordinatePair(lat, lng)).toThrow(DomainException);
  });

  it('names the missing field', () => {
    expect(details(() => assertCoordinatePair(17.4, null))?.[0].field).toBe('longitude');
    expect(details(() => assertCoordinatePair(null, 78.3))?.[0].field).toBe('latitude');
  });
});
