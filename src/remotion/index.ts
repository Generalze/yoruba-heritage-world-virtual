import { registerRoot } from 'remotion'

import { RemotionRoot } from './root'

/**
 * The file @remotion/bundler compiles at render time. Nothing else in
 * the application imports it, and it imports nothing from the
 * application: a compositor bundle has no business reaching the
 * database, the services or the environment.
 */
registerRoot(RemotionRoot)
