import { applyTestEnvironment } from './test-environment';

// Same as env-default but with a tiny request limit, to exercise rate limiting.
applyTestEnvironment({ THROTTLE_LIMIT: '3' });
