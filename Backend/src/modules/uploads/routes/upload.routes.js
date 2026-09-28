import express from 'express';
import { uploadImage, uploadVideo } from '../controllers/upload.controller.js';
import { imageUpload, videoUpload, uploadRateLimiter } from '../middleware/upload.middleware.js';
import { requireRoles } from '../../../core/roles/role.middleware.js';

const router = express.Router();

// POST /v1/uploads/image?folder=food/users/profile
// multipart field: file (required)
router.post(
    '/image',
    uploadRateLimiter,
    imageUpload.single('file'),
    uploadImage
);

// POST /v1/uploads/video?folder=food/items/videos
// multipart field: file (required). MP4 or WebM, stored as-is.
// Dish videos are added by the restaurant or an admin, nobody else.
router.post(
    '/video',
    requireRoles('RESTAURANT', 'ADMIN'),
    uploadRateLimiter,
    videoUpload.single('file'),
    uploadVideo
);

export default router;
