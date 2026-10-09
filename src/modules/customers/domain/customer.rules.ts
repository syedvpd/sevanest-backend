import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/errors/domain.exception';
import { ErrorCode } from '../../../common/errors/error-codes';

/** FRD FM-02: the location "can be set from the map", so coordinates are optional, but never half-set. */
export function assertCoordinatePair(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): void {
  if ((latitude == null) !== (longitude == null)) {
    throw new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [
        {
          field: latitude == null ? 'latitude' : 'longitude',
          messages: ['latitude and longitude must be provided together'],
        },
      ],
    );
  }
}
