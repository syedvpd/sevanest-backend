import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LegalDocumentView {
  @ApiProperty() version!: string;
  @ApiProperty({ nullable: true, type: String }) url!: string | null;
}

export class LegalCurrentView {
  @ApiProperty({ description: 'True when bookings require the current versions to be accepted.' })
  acceptanceRequired!: boolean;
  @ApiProperty({ type: LegalDocumentView, nullable: true }) terms!: LegalDocumentView | null;
  @ApiProperty({ type: LegalDocumentView, nullable: true }) privacy!: LegalDocumentView | null;
}

export class LegalStatusView {
  @ApiProperty() acceptanceRequired!: boolean;
  @ApiProperty({ description: 'The current versions of all published documents are accepted.' })
  accepted!: boolean;
  @ApiProperty({
    type: [String],
    description: 'TERMS and/or PRIVACY when the current version is not accepted yet.',
  })
  missing!: string[];
}

export class AcceptLegalDto {
  @ApiPropertyOptional({ description: 'Must equal the current terms version.' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9._-]{1,40}$/)
  termsVersion?: string;

  @ApiPropertyOptional({ description: 'Must equal the current privacy version.' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9._-]{1,40}$/)
  privacyVersion?: string;
}

export class RequestDeletionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class DeletionListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['REQUESTED', 'CANCELLED', 'COMPLETED', 'REJECTED'] })
  @IsOptional()
  @IsEnum(['REQUESTED', 'CANCELLED', 'COMPLETED', 'REJECTED'])
  status?: 'REQUESTED' | 'CANCELLED' | 'COMPLETED' | 'REJECTED';
}

export class DeletionRequestView {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ['REQUESTED', 'CANCELLED', 'COMPLETED', 'REJECTED'] }) status!: string;
  @ApiProperty() requestedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) rejectedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) rejectedReason!: string | null;
}

export class RejectDeletionDto {
  @ApiProperty({
    maxLength: 500,
    description: 'Why the request is refused; kept with the request and in the audit log.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(5, 500)
  reason!: string;
}
