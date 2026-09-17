import { GENERIC_ERROR_MESSAGE, looksInternal } from '../utils/publicError.js';
import { logger } from '../utils/logger.js';

/**
 * A last check on every error response before it leaves the server.
 *
 * The error handler already withholds unexpected errors, but not every failure
 * reaches it: a number of controllers catch their own errors and send
 * `err.message` straight back. This wraps res.json -- the same way
 * signMediaResponses does -- so whichever path produced the response, database
 * errors, stack traces and crash text are replaced with a plain message and a
 * reference the person can quote, and the original is logged.
 *
 * Only error bodies are looked at, and only their message fields.
 */
export const guardErrorResponses = (req, res, next) => {
    const original = res.json.bind(res);

    res.json = (body) => {
        if (body && typeof body === 'object' && !Array.isArray(body)
            && (body.success === false || res.statusCode >= 400)) {
            const leaked = ['message', 'error'].filter((k) => looksInternal(body[k]));
            if (leaked.length) {
                const requestId = req.requestId || '-';
                logger.error(
                    `[${requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} - withheld internal error: ${body[leaked[0]]}`,
                );
                const safe = { ...body, requestId };
                for (const k of leaked) safe[k] = GENERIC_ERROR_MESSAGE;
                return original(safe);
            }
        }
        return original(body);
    };

    next();
};
