import { Module } from '@nestjs/common';
import { MalwareModule } from '../../integrations/malware/malware.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { CustomerPhotoController } from './customer-photo.controller';
import { CustomerPhotoRepository } from './customer-photo.repository';
import { CustomerPhotoService } from './customer-photo.service';
import { CustomerPhotoEraser } from './customer-photo-eraser';

/**
 * The customer's own profile photo: same private storage, signed links and server-side checks as the worker photo. No other
 * module reads it; nothing shows a customer's photo to a worker or to staff until a visibility rule is approved.
 */
@Module({
  imports: [StorageModule, MalwareModule],
  controllers: [CustomerPhotoController],
  providers: [CustomerPhotoEraser, CustomerPhotoRepository, CustomerPhotoService],
  exports: [CustomerPhotoService],
})
export class CustomerPhotoModule {}
