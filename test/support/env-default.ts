import { applyTestEnvironment } from './test-environment';

// Side-effect module: import FIRST in a spec so the environment exists before AppModule is loaded.
applyTestEnvironment();
