/**
 * Fallback build-info constants for development / source distributions.
 *
 * This file is committed to git and serves as the default when
 * `electron/build-info.ts` has not been generated (i.e. `npm run build`
 * has not been run yet in the current environment).
 *
 * `scripts/gen-build-info.js` copies this content when it detects it is
 * running outside a git repository (e.g. packaged source distribution).
 *
 * DO NOT EDIT MANUALLY — update gen-build-info.js to change the generated format.
 */

export const GIT_COMMIT: string = 'dev';
export const APP_VERSION: string = '1.0.0';
export const GIT_BRANCH: string = 'dev';
export const BUILD_TIME: string = '';
