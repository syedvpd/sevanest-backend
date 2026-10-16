import type { GeoPoint } from './maps-provider.interface';

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres between two points (haversine). Exact enough for ordering workers by how far they are. */
export function haversineMeters(from: GeoPoint, to: GeoPoint): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLon = rad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidPoint(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}
