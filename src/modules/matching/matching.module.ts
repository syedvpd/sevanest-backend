import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { UsersModule } from '../users/users.module';
import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';

/** Matching: staff-side candidate selection for one requirement, built on Search's eligibility. Owns no tables. */
@Module({
  imports: [SearchModule, UsersModule],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
