import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DependencyHealth, HealthController } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DependencyHealth],
})
export class HealthModule {}
