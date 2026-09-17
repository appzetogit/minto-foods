/**
 * The image shown on push notifications when there is no better one.
 *
 * It was another brand's image on a free third-party host -- left over from the
 * codebase this platform was forked from, and shown on every order push a
 * Minto customer, restaurant or rider received. It is now the Minto logo from
 * our own bucket, which is publicly readable so a phone can fetch it when the
 * notification arrives.
 *
 * Set PUSH_BRAND_IMAGE_URL to use a different image without a code change.
 */
export const BRAND_IMAGE_URL =
    process.env.PUSH_BRAND_IMAGE_URL
    || 'https://minto-media.s3.ap-south-1.amazonaws.com/business/logos/minto-logo.webp';
