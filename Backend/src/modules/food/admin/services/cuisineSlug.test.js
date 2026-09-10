import test from 'node:test';
import assert from 'node:assert/strict';

import { cuisineSlug } from './adminCuisine.service.js';

/**
 * What makes two spellings the same cuisine.
 *
 * The restaurant column is free text and always was, so the vocabulary has to
 * fold variants together or the picker becomes the same mess it replaced --
 * "North Indian", "north indian" and "North  Indian" sitting side by side, none
 * of them selectable as the same thing.
 */

test('case does not make a new cuisine', () => {
    assert.equal(cuisineSlug('North Indian'), cuisineSlug('north indian'));
    assert.equal(cuisineSlug('CHINESE'), cuisineSlug('Chinese'));
});

test('stray whitespace does not make a new cuisine', () => {
    assert.equal(cuisineSlug('North  Indian'), cuisineSlug('North Indian'));
    assert.equal(cuisineSlug('  Chinese  '), cuisineSlug('Chinese'));
    assert.equal(cuisineSlug('North\tIndian'), cuisineSlug('North Indian'));
});

test('genuinely different cuisines stay different', () => {
    assert.notEqual(cuisineSlug('South Indian'), cuisineSlug('North Indian'));
    assert.notEqual(cuisineSlug('Thai'), cuisineSlug('Chinese'));
});

test('the slug is not destructive beyond case and spacing', () => {
    // Punctuation is left alone on purpose. Stripping it would fold
    // "Indo-Chinese" into "Indo Chinese", which may be wanted -- but it would
    // also fold distinct names silently, and that is worse than a duplicate an
    // admin can see and merge.
    assert.notEqual(cuisineSlug('Indo-Chinese'), cuisineSlug('Indo Chinese'));
});

test('nothing in gives an empty slug rather than throwing', () => {
    for (const missing of [null, undefined, '', '   ']) {
        assert.equal(cuisineSlug(missing), '');
    }
});

test('a name is not lowercased for display, only for matching', () => {
    // The slug is the comparison key; the row keeps whatever was typed, so
    // "North Indian" is displayed rather than "north indian".
    assert.equal(cuisineSlug('North Indian'), 'north indian');
});
