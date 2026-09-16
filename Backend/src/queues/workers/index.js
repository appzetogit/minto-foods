/**
 * Both BullMQ workers in one process.
 *
 * Each worker file starts itself on import. They could run as two pm2 processes,
 * but on a 2 GB box a second Node runtime costs ~120 MB to process a handful of
 * jobs a minute, so they share one.
 *
 * This process is what makes BULLMQ_ENABLED safe. Without a consumer, enabling
 * BullMQ does not fail loudly -- addOrderJob succeeds, and the dispatch retry and
 * restaurant-acceptance timeouts it schedules sit in Redis forever. With BullMQ
 * off, the same calls are silent no-ops. Either way nothing fires unless this
 * runs, so it must be started together with the flag.
 */
import './order.worker.js';
import './tracking.worker.js';
