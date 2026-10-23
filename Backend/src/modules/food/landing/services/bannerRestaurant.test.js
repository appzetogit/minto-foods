import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { resolveBannerLink } from './bannerRestaurant.service.js';
import {
    getPublicHomePromotionBanners,
    listHomePromotionBanners,
    updateHomePromotionBanner,
} from './homePromotionBanner.service.js';

/**
 * Banners that open a restaurant: stored by id so a rename cannot break them,
 * and hidden while the restaurant is switched off.
 */
const created = { restaurants: [], banners: [] };

const makeRestaurant = async (name, extra = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: name, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved', ...extra },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeBanner = async (data) => {
    const b = await prisma.homePromotionBanner.create({
        data: { imageUrl: 'https://example.com/b.png', publicId: 'b', isActive: true, ...data },
    });
    created.banners.push(b.id);
    return b;
};

test.after(async () => {
    await prisma.homePromotionBanner.deleteMany({ where: { id: { in: created.banners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a restaurant link by slug or by id is saved as the restaurant id', async () => {
    const tag = uniqueTag('Zinger');
    const r = await makeRestaurant(`${tag} madness - CRUNCHY BURGERS`);
    const slug = `${tag.toLowerCase()}-madness-crunchy-burgers`;

    assert.deepEqual(
        await resolveBannerLink({ ctaLink: `/food/user/restaurants/${slug}` }),
        { restaurantId: r.id, ctaLink: `/food/user/restaurants/${r.id}` },
    );
    assert.deepEqual(
        await resolveBannerLink({ restaurantId: r.id, ctaLink: '/anything' }),
        { restaurantId: r.id, ctaLink: `/food/user/restaurants/${r.id}` },
    );
    // Not a restaurant link: kept as it is.
    assert.deepEqual(await resolveBannerLink({ ctaLink: '/food/user/under250' }), {
        ctaLink: '/food/user/under250', restaurantId: null,
    });
    // A link to no restaurant is refused rather than saved broken.
    await assert.rejects(() => resolveBannerLink({ ctaLink: '/food/user/restaurants/no-such-place-xyz' }), /does not exist/);
    // Nothing sent: nothing changes.
    assert.deepEqual(await resolveBannerLink({}), {});
});

test('editing a banner stores the restaurant id, so a rename does not break it', async () => {
    const r = await makeRestaurant(`${uniqueTag('Sdad')}`);
    const banner = await makeBanner({ title: 'ramdev' });

    const saved = await updateHomePromotionBanner(banner.id, { ctaLink: `/food/user/restaurants/${r.nameSlug ?? r.id}` });
    assert.equal(saved.restaurantId, r.id);
    assert.equal(saved.ctaLink, `/food/user/restaurants/${r.id}`);

    await prisma.foodRestaurant.update({ where: { id: r.id }, data: { restaurantName: uniqueTag('Saad') } });
    const listed = (await listHomePromotionBanners()).find((b) => b.id === banner.id);
    assert.equal(listed.restaurantLinkBroken, false);
    assert.equal(listed.restaurantId, r.id);
});

test('the admin list flags a banner whose restaurant slug matches nothing', async () => {
    const banner = await makeBanner({ title: 'orphan', ctaLink: '/food/user/restaurants/sdad-gone-forever-xyz' });
    const listed = (await listHomePromotionBanners()).find((b) => b.id === banner.id);
    assert.equal(listed.restaurantLinkBroken, true);
});

test('a banner for a restaurant switched offline leaves the public list', async () => {
    const online = await makeRestaurant(uniqueTag('Online'));
    const offline = await makeRestaurant(uniqueTag('Offline'), { isAcceptingOrders: false });
    const onBanner = await makeBanner({ restaurantId: online.id, ctaLink: `/food/user/restaurants/${online.id}` });
    const offBanner = await makeBanner({ restaurantId: offline.id, ctaLink: `/food/user/restaurants/${offline.id}` });
    // An old banner that only has the slug in its link is caught too.
    const offBySlug = await makeBanner({ ctaLink: `/food/user/restaurants/${offline.restaurantName.toLowerCase()}` });
    const noLink = await makeBanner({ ctaLink: '/food/user/under250' });

    const ids = new Set((await getPublicHomePromotionBanners()).map((b) => b.id));
    assert.ok(ids.has(onBanner.id));
    assert.ok(ids.has(noLink.id), 'a banner linking to no restaurant is unaffected');
    assert.ok(!ids.has(offBanner.id));
    assert.ok(!ids.has(offBySlug.id));

    const shown = (await getPublicHomePromotionBanners()).find((b) => b.id === onBanner.id);
    assert.equal(shown.restaurantId, online.id, 'the app gets the restaurant id');
});
