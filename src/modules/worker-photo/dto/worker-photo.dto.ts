import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RequestPhotoUploadDto {
  @ApiProperty({ example: 'image/jpeg', description: 'image/jpeg or image/png' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  contentType!: string;

  @ApiProperty({ example: 250000, description: 'Size in bytes of the file you will upload.' })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  sizeBytes!: number;
}

export class PhotoUploadResponse {
  @ApiProperty() photoId!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ enum: ['PUT'] }) method!: 'PUT';
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() contentType!: string;
  @ApiProperty() maxBytes!: number;
}

export class PhotoLink {
  @ApiProperty({
    description:
      'Short-lived link to the small square WebP (320 px) for cards and lists. Do not store the link; cache the image by `cacheKey`.',
  })
  url!: string;
  @ApiProperty({
    description:
      'Short-lived link to the large WebP (longest side at most 1080 px) for the profile screen.',
  })
  largeUrl!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({
    description:
      'Stable while the photo is unchanged: use it as the image cache key, because the signed links change on every read.',
  })
  cacheKey!: string;
}
