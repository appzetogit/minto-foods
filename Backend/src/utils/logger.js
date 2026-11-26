// Node sets this in every `node --test` child. Those children talk to the
// runner over their own stdout, and heavy interleaved logging from concurrent
// work corrupts that stream ("Unable to deserialize cloned data"), failing a
// whole file that otherwise passes. Tests assert on behaviour, not on logs.
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);
const stamp = () => new Date().toLocaleTimeString();

// Variadic, because the usual call is a message and the error that caused it.
// Taking a single argument meant `logger.error('upload failed:', err)` printed
// the message and dropped the error — which is the half worth having.
// debug did not exist, yet the rider-location socket handler called
// logger.debug whenever it dropped a bad GPS fix. The TypeError became an
// unhandled rejection, which shut the API process down in production -- every
// request in flight got a 502. It is quiet unless LOG_LEVEL=debug, because a
// dropped fix happens many times a minute.
const debugOn = String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug';

export const logger = {
    debug: (...args) => { if (!quiet && debugOn) console.log(`🔍 [DEBUG] ${stamp()}:`, ...args); },
    info: (...args) => { if (!quiet) console.log(`✅ [INFO] ${stamp()}:`, ...args); },
    error: (...args) => { if (!quiet) console.error(`❌ [ERROR] ${stamp()}:`, ...args); },
    warn: (...args) => { if (!quiet) console.warn(`⚠️ [WARN] ${stamp()}:`, ...args); }
};
