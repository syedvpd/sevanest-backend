import { Injectable } from '@nestjs/common';
import { providerRequest } from '../http/provider-http';
import { ProviderError } from '../provider-error';
import { haversineMeters, isValidPoint } from './haversine';
import type { GeoPoint, MapsProvider } from './maps-provider.interface';

/** Used while no geocoder is configured (DEC-18): addresses are saved without coordinates; distances are still computed locally. */
@Injectable()
export class DisabledMapsProvider implements MapsProvider {
  geocode(): Promise<GeoPoint | null> {
    return Promise.resolve(null);
  }

  distanceMeters(from: GeoPoint, to: GeoPoint): Promise<number> {
    return Promise.resolve(haversineMeters(from, to));
  }
}

/**
 * Test and local adapter. `points` maps a fragment of an address to a point (first match wins); anything else gets a stable pseudo point
 * derived from the text, so a test can rely on "same address, same point". Refused in production and staging by configuration.
 */
@Injectable()
export class InMemoryMapsProvider implements MapsProvider {
  readonly points = new Map<string, GeoPoint>();
  readonly requests: string[] = [];
  failWith: Error | null = null;
  /** When true, unknown addresses are "not found" (null) instead of getting a pseudo point. */
  unknownIsNotFound = false;

  geocode(address: string): Promise<GeoPoint | null> {
    this.requests.push(address);
    if (this.failWith) return Promise.reject(this.failWith);
    for (const [fragment, point] of this.points) {
      if (address.includes(fragment)) return Promise.resolve(point);
    }
    if (this.unknownIsNotFound) return Promise.resolve(null);
    let hash = 0;
    for (const ch of address) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return Promise.resolve({
      latitude: 12 + (hash % 10_000) / 1000,
      longitude: 72 + ((hash >>> 8) % 10_000) / 1000,
    });
  }

  distanceMeters(from: GeoPoint, to: GeoPoint): Promise<number> {
    return Promise.resolve(haversineMeters(from, to));
  }
}

export interface GoogleMapsSettings {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * Google Geocoding API (address to coordinates, India only). ZERO_RESULTS is "not found" (null), not an error. Quota and server
 * problems are retryable, a denied or invalid request is permanent. The request URL (which carries the key) and the address never
 * appear in an error message. Distance is the local haversine: no Distance Matrix call and no cost per comparison.
 */
@Injectable()
export class GoogleGeocodingProvider implements MapsProvider {
  constructor(private readonly settings: GoogleMapsSettings) {}

  async geocode(address: string): Promise<GeoPoint | null> {
    const base = this.settings.baseUrl ?? 'https://maps.googleapis.com';
    const url =
      `${base}/maps/api/geocode/json?address=${encodeURIComponent(address)}` +
      `&components=country:IN&key=${encodeURIComponent(this.settings.apiKey)}`;
    const { json } = await providerRequest(
      'google-maps',
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      this.settings.timeoutMs,
    );
    const reply = json as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat?: unknown; lng?: unknown } } }>;
    } | null;
    switch (reply?.status) {
      case 'OK': {
        const location = reply.results?.[0]?.geometry?.location;
        const point = { latitude: Number(location?.lat), longitude: Number(location?.lng) };
        if (!isValidPoint(point)) {
          throw new ProviderError(
            'google-maps',
            'google-maps returned an unusable location',
            false,
          );
        }
        return point;
      }
      case 'ZERO_RESULTS':
        return null;
      case 'OVER_QUERY_LIMIT':
      case 'UNKNOWN_ERROR':
        throw new ProviderError('google-maps', `google-maps answered ${reply.status}`, true);
      default:
        throw new ProviderError('google-maps', 'google-maps refused the request', false);
    }
  }

  distanceMeters(from: GeoPoint, to: GeoPoint): Promise<number> {
    return Promise.resolve(haversineMeters(from, to));
  }
}
