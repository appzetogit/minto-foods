/**
 * Restaurant links: slugs, and the restaurant a banner link points at.
 *
 * The slug rule is the database's restaurant_name_slug() (see constraints.sql),
 * which keeps food_restaurants.nameSlug in step with the name. The two must stay
 * identical or a link built here would not match the stored column.
 */

/** Lowercase, every run of non-alphanumerics one hyphen, hyphens trimmed. */
export const slugifyRestaurantName = (name) => {
    const slug = String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || null;
};

/** What follows /restaurants/ in a link: an id or a slug. Null when it is not a restaurant link. */
export const restaurantKeyFromLink = (link) => {
    const match = /\/restaurants\/([^/?#\s]+)/.exec(String(link || ''));
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]).trim() || null;
    } catch {
        return match[1].trim() || null;
    }
};

/** The customer app's link to a restaurant, by id so a rename cannot break it. */
export const restaurantLink = (id) => `/food/user/restaurants/${id}`;
