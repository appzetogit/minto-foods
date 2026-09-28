import multer from 'multer';
import { config } from '../../../config/env.js';
import { MAX_VIDEO_MB } from '../../../services/storage.service.js';

const memoryStorage = multer.memoryStorage();

export const imageUpload = multer({
    storage: memoryStorage,
    limits: {
        fileSize: config.uploadMaxFileSizeBytes,
        files: 1
    },
    fileFilter: (_req, file, cb) => {
        const mimeType = String(file.mimetype || '').toLowerCase();
        if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
            return cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
        }
        return cb(null, true);
    }
});

/**
 * One dish video. The size and format are checked again by saveVideoFile; this
 * refuses the obvious cases before the whole file is read into memory.
 */
export const videoUpload = multer({
    storage: memoryStorage,
    limits: {
        fileSize: MAX_VIDEO_MB * 1024 * 1024,
        files: 1
    },
    fileFilter: (_req, file, cb) => {
        const mimeType = String(file.mimetype || '').toLowerCase();
        if (!['video/mp4', 'video/webm'].includes(mimeType)) {
            return cb(new Error('Only MP4 and WebM videos are supported'));
        }
        return cb(null, true);
    }
});

export { uploadRateLimiter } from '../../../middleware/rateLimit.js';
