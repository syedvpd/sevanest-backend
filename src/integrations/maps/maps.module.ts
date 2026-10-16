import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { MapsProviderKind } from '../../config/env.validation';
import { MAPS_PROVIDER, type MapsProvider } from './maps-provider.interface';
import {
  DisabledMapsProvider,
  GoogleGeocodingProvider,
  InMemoryMapsProvider,
} from './maps-providers';

/** The maps provider (DEC-18). Global so Customers and Workers geocode saved addresses without importing each other. */
@Global()
@Module({
  providers: [
    {
      provide: MAPS_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): MapsProvider => {
        switch (config.mapsProvider) {
          case MapsProviderKind.Memory:
            return new InMemoryMapsProvider();
          case MapsProviderKind.Google:
            return new GoogleGeocodingProvider(config.googleMaps);
          default:
            return new DisabledMapsProvider();
        }
      },
    },
  ],
  exports: [MAPS_PROVIDER],
})
export class MapsModule {}
