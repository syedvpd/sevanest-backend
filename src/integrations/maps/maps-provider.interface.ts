/** Location, distance and service-area lookups (PRD §11). Google Maps or an alternative; provider not yet selected. */
export const MAPS_PROVIDER = Symbol('MAPS_PROVIDER');

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface MapsProvider {
  geocode(address: string): Promise<GeoPoint | null>;
  distanceMeters(from: GeoPoint, to: GeoPoint): Promise<number>;
}
