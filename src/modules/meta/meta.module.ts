import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller';

/** App start-up configuration and reference lists (public, read-only). Uses the global Legal and Config services. */
@Module({ controllers: [MetaController] })
export class MetaModule {}
