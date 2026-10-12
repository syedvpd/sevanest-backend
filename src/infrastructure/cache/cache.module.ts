import { Global, Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, HeartbeatService],
  exports: [RedisService, HeartbeatService],
})
export class CacheModule {}
