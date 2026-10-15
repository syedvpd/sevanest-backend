import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import {
  PhotoLink,
  PhotoUploadResponse,
  RequestPhotoUploadDto,
} from '../worker-photo/dto/worker-photo.dto';
import { CustomerPhotoService } from './customer-photo.service';

/** The signed-in customer's own profile photo. Scoped to the authenticated user; no customer id is accepted. */
@ApiTags('Customer photo')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'customers/me/photo', version: '1' })
export class CustomerPhotoController {
  constructor(private readonly photos: CustomerPhotoService) {}

  @Post()
  @ApiModelResponse(PhotoUploadResponse, { status: 201 })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask for a short-lived upload link for a new profile photo',
    description:
      'JPEG or PNG within the configured size. 503 PHOTO_NOT_CONFIGURED until PROFILE_PHOTO_MAX_BYTES is set; 413 too large; 422 type not allowed or too many unconfirmed uploads. Upload the bytes to the link with PUT, then confirm. An upload that is never confirmed is discarded after 24 hours.',
  })
  request(
    @Body() dto: RequestPhotoUploadDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PhotoUploadResponse> {
    return this.photos.requestUpload(user.userId, dto);
  }

  @Post(':photoId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm the upload; the photo becomes current once its size, file signature and content check out',
    description:
      'Errors: 422 PHOTO_NOT_UPLOADED, PHOTO_CONTENT_MISMATCH or PHOTO_MALWARE_DETECTED; 404 for an unknown photo or a photo of another customer. Repeating is harmless. The previous photo is removed.',
  })
  confirm(
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ photoId: string; status: 'READY' }> {
    return this.photos.confirm(user.userId, photoId);
  }

  @Get()
  @ApiModelResponse(PhotoLink)
  @ApiOperation({
    summary: 'A short-lived link to my current photo (404 PHOTO_NOT_FOUND when none)',
  })
  mine(@CurrentUser() user: AuthenticatedUser): Promise<PhotoLink> {
    return this.photos.getMine(user.userId);
  }
}
