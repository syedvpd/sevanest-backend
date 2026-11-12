import { applyTestEnvironment } from './test-environment';

// Same as env-default but with tiny request limits, to exercise both general and admin-auth rate limiting + CORS headers.
applyTestEnvironment({
  THROTTLE_LIMIT: '3',
  ADMIN_AUTH_THROTTLE_LIMIT: '2',
  CORS_ORIGINS: 'https://admin.sevanest.test',
});
