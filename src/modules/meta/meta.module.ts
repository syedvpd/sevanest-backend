import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '../platform-config/platform-config.module';
import { ReplacementModule } from '../replacement/replacement.module';
import { MetaController } from './meta.controller';

/** App start-up configuration and reference lists (public, read-only). Reads the database-backed settings and rating tags from PlatformConfig, and the global Legal and Config services. */
@Module({ imports: [PlatformConfigModule, ReplacementModule], controllers: [MetaController] })
export class MetaModule {}
