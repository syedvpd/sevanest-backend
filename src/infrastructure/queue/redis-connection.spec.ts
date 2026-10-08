import { redisConnectionFromUrl } from './redis-connection';

describe('redisConnectionFromUrl', () => {
  it('parses a plain local URL', () => {
    expect(redisConnectionFromUrl('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it('parses credentials, db index and TLS', () => {
    const c = redisConnectionFromUrl('rediss://user:p%40ss@cache.example.com:6380/2') as Record<
      string,
      unknown
    >;
    expect(c).toMatchObject({
      host: 'cache.example.com',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
    });
    expect(c['tls']).toEqual({});
  });
});
