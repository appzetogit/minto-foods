import test from 'node:test';
import assert from 'node:assert/strict';

import { restaurantKeyFromLink, restaurantLink, slugifyRestaurantName } from './restaurantSlug.js';

test('a name becomes the slug banners link with', () => {
    assert.equal(
        slugifyRestaurantName('Zinger madness - CRUNCHY BURGERS AND MORE'),
        'zinger-madness-crunchy-burgers-and-more',
    );
    assert.equal(slugifyRestaurantName("Tanu's Restaurant"), 'tanu-s-restaurant');
    assert.equal(slugifyRestaurantName('  --Café & Bar!!  '), 'caf-bar');
    assert.equal(slugifyRestaurantName('zinger-madness-crunchy-burgers-and-more'), 'zinger-madness-crunchy-burgers-and-more');
    assert.equal(slugifyRestaurantName('***'), null);
});

test('the restaurant key in a banner link', () => {
    assert.equal(restaurantKeyFromLink('/food/user/restaurants/zinger-madness'), 'zinger-madness');
    assert.equal(restaurantKeyFromLink('/food/user/restaurants/50771f5871b62bbfbc4f599e?x=1'), '50771f5871b62bbfbc4f599e');
    assert.equal(restaurantKeyFromLink('/food/user/under250'), null);
    assert.equal(restaurantKeyFromLink(''), null);
    assert.equal(restaurantLink('abc'), '/food/user/restaurants/abc');
});
