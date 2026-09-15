import { stripOwnBucketSignature } from '../services/storage.service.js';

/**
 * Strips our own S3 signatures out of anything a client sends us.
 *
 * A signed url that reaches the database is frozen: mediaSigning refuses to
 * re-sign a url that already carries X-Amz-Signature, so the row keeps serving
 * the original one and the image 403s an hour after it was uploaded. Nothing
 * ever repairs it, because nothing can tell that row apart from a working one.
 *
 * It gets there honestly. Every response signs its media, so a panel that loads
 * a category, lets someone rename it and posts the object back is posting the
 * signed url it was given. That is the obvious thing for a client to do, and
 * asking every client not to do it has not worked.
 *
 * storage.service.js has had the rule for a while, but as a function that write
 * paths must remember to call -- and category writes, among others, did not.
 * This is the same rule applied where it cannot be forgotten: the mirror of
 * signMediaResponses, undoing on the way in exactly what that does on the way
 * out. Only our own bucket and only the query string; an external signed url
 * belongs to someone else and is left alone.
 */
const clean = (node, depth = 0) => {
    // Deep enough for any real payload; a guard against a cyclic or hostile one.
    if (depth > 12) return node;
    if (typeof node === 'string') return stripOwnBucketSignature(node);
    if (Array.isArray(node)) return node.map((v) => clean(v, depth + 1));
    if (node && typeof node === 'object') {
        if (node.constructor && node.constructor !== Object) return node;
        for (const [k, v] of Object.entries(node)) node[k] = clean(v, depth + 1);
    }
    return node;
};

export const stripIncomingSignatures = (req, _res, next) => {
    if (req.body && typeof req.body === 'object') req.body = clean(req.body);
    next();
};
