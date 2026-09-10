/**
 * Remove baked-in S3 signatures from stored media urls.
 *
 * A signed url that reached the database is frozen: mediaSigning refuses to
 * re-sign anything already carrying X-Amz-Signature, so the row serves a url
 * that 403s forever once its hour is up. storage.service.js now strips the
 * query on the way in; this repairs the rows written before that.
 *
 * The repair is exactly "drop the query string", so it is idempotent and safe
 * to re-run. Reports without writing unless --apply is passed.
 *
 *   node scripts/strip-stored-signatures.mjs                    # rolex hotel, dry run
 *   node scripts/strip-stored-signatures.mjs --apply            # rolex hotel, write
 *   node scripts/strip-stored-signatures.mjs --all              # every table, dry run
 *   node scripts/strip-stored-signatures.mjs --all --apply      # every table, write
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
// The same rule the write path now applies, so a row repaired here and a row
// saved today cannot disagree.
import { normalizeMediaUrlForStorage } from '../src/services/storage.service.js';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const ROLEX_ID = '194c7ac72c53fb39da49850c';

/** Bare object url when normalizing actually changed something, else null. */
const strip = (value) => {
    if (typeof value !== 'string' || !value.startsWith('http')) return null;
    const normalized = normalizeMediaUrlForStorage(value);
    return normalized && normalized !== value ? normalized : null;
};

/** Walk any JSON shape, stripping as it goes. Returns [fixed, count]. */
const stripDeep = (node) => {
    if (typeof node === 'string') {
        const s = strip(node);
        return s ? [s, 1] : [node, 0];
    }
    if (Array.isArray(node)) {
        let n = 0;
        const out = node.map((v) => { const [f, c] = stripDeep(v); n += c; return f; });
        return [out, n];
    }
    if (node && typeof node === 'object') {
        let n = 0;
        const out = {};
        for (const [k, v] of Object.entries(node)) { const [f, c] = stripDeep(v); n += c; out[k] = f; }
        return [out, n];
    }
    return [node, 0];
};

// model -> the columns that can hold a url. Scalars, string lists and json all
// go through stripDeep, so the shape does not need declaring.
const TARGETS = [
    ['foodRestaurant', ['profileImage', 'coverImage', 'menuImages', 'coverImages', 'galleryImages', 'videos']],
    ['foodUser', ['profileImage']],
    ['foodAdmin', ['profileImage']],
    ['foodDeliveryPartner', ['customDocuments']],
    ['foodItem', ['image', 'images']],
    ['foodCategory', ['image']],
    ['orderItem', ['image']],
    ['foodDiningCategory', ['imageUrl']],
    ['foodHeroBanner', ['imageUrl']],
    ['foodUnder250Banner', ['imageUrl']],
    ['foodDiningBanner', ['imageUrl']],
    ['homePromotionBanner', ['imageUrl']],
    ['foodRestaurantAppBanner', ['imageUrl']],
    ['topBanner', ['image']],
    ['foodExploreIcon', ['iconUrl']],
];

let totalRows = 0;
let totalUrls = 0;

for (const [model, fields] of TARGETS) {
    const delegate = prisma[model];
    if (!delegate) { console.log(`skip ${model} (no such model)`); continue; }

    const where = !ALL && model === 'foodRestaurant' ? { id: ROLEX_ID } : undefined;
    if (!ALL && model !== 'foodRestaurant') continue;

    const rows = await delegate.findMany({
        where,
        select: Object.fromEntries([['id', true], ...fields.map((f) => [f, true])]),
    });

    for (const row of rows) {
        const patch = {};
        let rowUrls = 0;
        for (const f of fields) {
            if (row[f] === null || row[f] === undefined) continue;
            const [fixed, n] = stripDeep(row[f]);
            if (n > 0) { patch[f] = fixed; rowUrls += n; }
        }
        if (!rowUrls) continue;

        totalRows += 1;
        totalUrls += rowUrls;
        console.log(`${model} ${row.id}: ${rowUrls} url(s) in ${Object.keys(patch).join(', ')}`);

        if (APPLY) {
            await delegate.update({ where: { id: row.id }, data: patch });
            console.log('  updated');
        }
    }
}

console.log('');
console.log(`${totalRows} row(s), ${totalUrls} url(s) ${APPLY ? 'repaired' : 'would be repaired'}`);
if (!APPLY && totalUrls) console.log('Re-run with --apply to write.');

process.exit(0);
