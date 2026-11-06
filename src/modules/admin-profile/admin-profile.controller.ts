import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { AdminProfileService, ADMIN_PHOTO_TRANSPORT_LIMIT_BYTES } from './admin-profile.service';
import type { UploadedImage } from './admin-profile.service';
import { AdminProfileView, UpdateAdminProfileDto } from './dto/admin-profile.dto';

/**
 * The signed-in admin's own account ("My Account" / Staff Profile). Every route is scoped to the id in the access
 * token, so there is deliberately no `:userId` path or body field: an admin can only read and change their own profile.
 */
@ApiTags('Admin - My profile')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/me', version: '1' })
export class AdminProfileController {
  constructor(private readonly profiles: AdminProfileService) {}

  @Get('profile')
  @ApiModelResponse(AdminProfileView)
  @ApiOperation({
    summary: 'My profile: name, e-mail, phone, role, status and current photo',
    description:
      'Always the authenticated admin. `fullName` and `photo` are null until set. The photo is returned as two short-lived signed URLs (card and large WebP); re-fetch the profile when they expire.',
  })
  getMine(@CurrentUser() user: AuthenticatedUser): Promise<AdminProfileView> {
    return this.profiles.getMine(user.userId);
  }

  @Patch('profile')
  @ApiModelResponse(AdminProfileView)
  @ApiOperation({
    summary: 'Update my name, e-mail or phone number (partial update)',
    description:
      'Every field is optional but at least one is required. Omitted fields keep their value. E-mail and phone must be unique. ' +
      'Role, permissions, account status, password and provider identifiers are not accepted (unknown fields are stripped). ' +
      'Errors: 400 VALIDATION_FAILED; 409 ADMIN_EMAIL_TAKEN or ADMIN_PHONE_TAKEN.',
  })
  @ApiResponse({
    status: 409,
    description: 'The e-mail or phone is already used by another account.',
  })
  update(
    @Body() dto: UpdateAdminProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminProfileView> {
    return this.profiles.update(user.userId, dto);
  }

  @Post('profile-photo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: ADMIN_PHOTO_TRANSPORT_LIMIT_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description:
      'The image in the `file` field. JPEG, PNG or WebP; the real bytes are checked, not the filename or declared type. ' +
      'The configured limit (PROFILE_PHOTO_MAX_BYTES, default 5 MB) applies.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiModelResponse(AdminProfileView)
  @ApiOperation({
    summary: 'Upload or replace my profile photo',
    description:
      'The image is validated, stripped of metadata and re-encoded to WebP renditions in private storage; the response is the updated profile with fresh signed URLs. ' +
      'Replacing is atomic: if validation, storage or the database fails, the previous photo stays current. ' +
      'Errors: 413 PAYLOAD_TOO_LARGE; 422 ADMIN_PHOTO_REQUIRED, ADMIN_PHOTO_TYPE_NOT_ALLOWED, ADMIN_PHOTO_CONTENT_MISMATCH, ADMIN_PHOTO_INVALID or ADMIN_PHOTO_MALWARE_DETECTED; ' +
      '503 ADMIN_PHOTO_NOT_CONFIGURED or ADMIN_PHOTO_STORAGE_UNAVAILABLE.',
  })
  @ApiResponse({ status: 413, description: 'The image exceeds the configured size limit.' })
  @ApiResponse({
    status: 422,
    description: 'No file, an unsupported type, a spoofed/malformed image, or a malware verdict.',
  })
  @ApiResponse({
    status: 503,
    description: 'Photo upload is not configured, or image storage is unavailable.',
  })
  upload(
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminProfileView> {
    return this.profiles.uploadPhoto(user.userId, file);
  }
}
