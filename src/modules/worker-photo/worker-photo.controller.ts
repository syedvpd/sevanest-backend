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
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { PhotoLink, PhotoUploadResponse, RequestPhotoUploadDto } from './dto/worker-photo.dto';
import { WorkerPhotoService } from './worker-photo.service';

/** The signed-in worker's own profile photo (FR-WON-002). Scoped to the authenticated user; no worker id is accepted. */
@ApiTags('Worker photo')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/photo', version: '1' })
export class WorkerPhotoController {
  constructor(private readonly photos: WorkerPhotoService) {}

  @Post()
  @ApiModelResponse(PhotoUploadResponse, { status: 201 })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask for a short-lived upload link for a new profile photo',
    description:
      'JPEG or PNG within the configured size. 503 PHOTO_NOT_CONFIGURED until PROFILE_PHOTO_MAX_BYTES is set; 413 too large; 422 type not allowed or too many unconfirmed uploads. Upload the bytes to the link, then confirm.',
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
      'Confirm the upload; the photo becomes current once its size and file signature check out',
    description:
      "422 PHOTO_NOT_UPLOADED / PHOTO_CONTENT_MISMATCH; 404 for an unknown photo or another worker's photo. Repeating is harmless.",
  })
  confirm(
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ photoId: string; status: 'READY' }> {
    return this.photos.confirm(user.userId, photoId);
  }

  @Get()
  @ApiModelResponse(PhotoLink)
  @ApiOperation({ summary: 'A short-lived link to my current photo (404 when none)' })
  mine(@CurrentUser() user: AuthenticatedUser): Promise<PhotoLink> {
    return this.photos.getMine(user.userId);
  }
}
