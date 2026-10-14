import { Module } from '@nestjs/common';
import { MalwareModule } from '../../integrations/malware/malware.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { WorkersModule } from '../workers/workers.module';
import { WorkerPhotoController } from './worker-photo.controller';
import { WorkerPhotoRepository } from './worker-photo.repository';
import { WorkerPhotoService } from './worker-photo.service';

/**
 * Worker profile photo (FR-WON-002): private storage, signed upload and view links, server-side size and signature checks.
 * Depends on Workers (ownership, the current-photo reference) and the shared storage provider. Search and Shortlist use
 * `WorkerPhotoService.linksFor` to show a photo to customers.
 */
@Module({
  imports: [WorkersModule, StorageModule, MalwareModule],
  controllers: [WorkerPhotoController],
  providers: [WorkerPhotoRepository, WorkerPhotoService],
  exports: [WorkerPhotoService],
})
export class WorkerPhotoModule {}
