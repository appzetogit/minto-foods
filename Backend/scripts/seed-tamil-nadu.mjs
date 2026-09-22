/**
 * Tamil Nadu launch data: one state-wide zone (the state's real outline),
 * six approved restaurants in its main cities with a 50 km delivery radius,
 * their menus, and a Tamil Nadu-only "South Indian" category.
 *
 * Photos are reused from dishes and restaurants already on the platform, so
 * nothing new is uploaded. Idempotent: re-running updates rather than
 * duplicating (zone and city by name, restaurants on the name+phone unique
 * pair, dishes by restaurant+name).
 *
 *   node scripts/seed-tamil-nadu.mjs /path/to/tn_ring.json
 */
import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '../src/config/prisma.js';
import { deriveRestaurantFields, fromRestaurantLocation } from '../src/modules/food/restaurant/restaurant.mapper.js';
import { invalidateActiveZonesCache } from '../src/modules/food/landing/controllers/zonePublic.controller.js';
import { invalidateCache } from '../src/middleware/cache.js';

const ring = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(ring) || ring.length < 3) throw new Error('boundary ring missing');

// ---- city and zone ------------------------------------------------------------
const city = await prisma.foodCity.upsert({
    where: { nameKey: 'tamil nadu' },
    create: { name: 'Tamil Nadu', nameKey: 'tamil nadu', state: 'Tamil Nadu' },
    update: {},
});

const zoneData = {
    name: 'Tamil Nadu',
    zoneName: 'Tamil Nadu',
    serviceLocation: 'Tamil Nadu',
    country: 'India',
    city: city.name,
    cityId: city.id,
    unit: 'kilometer',
    coordinates: ring,
    isActive: true,
};
const existingZone = await prisma.foodZone.findFirst({ where: { name: 'Tamil Nadu' } });
const zone = existingZone
    ? await prisma.foodZone.update({ where: { id: existingZone.id }, data: zoneData })
    : await prisma.foodZone.create({ data: zoneData });

const [shape] = await prisma.$queryRaw`
    SELECT ST_IsValid(boundary::geometry) AS valid,
           ROUND((ST_Area(boundary) / 1e6)::numeric) AS km2
    FROM food_zones WHERE id = ${zone.id}`;
console.log(`zone: ${zone.name} (${zone.id}) valid=${shape?.valid} area=${shape?.km2} km2`);

// ---- photos already on the platform -------------------------------------------
const photo = async (name) => {
    const row = await prisma.foodItem.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, image: { startsWith: 'http' } },
        select: { image: true },
    });
    return row?.image || '';
};
const P = {
    dosa: await photo('Dosa'),
    thali: await photo('thali'),
    paratha: await photo('Paratha'),
    friedRice: await photo('fried rice'),
    tripleRice: await photo('triple rice'),
    noodles: await photo('noodles'),
    butterChicken: await photo('butter chicken'),
    chicken: await photo('Chicken'),
    biryani: await photo('Veg Birani'),
    paneerTikka: await photo('paneer tikka'),
    gulabJamun: await photo('Gulab Jamun'),
    jalebi: await photo('Jalebi'),
    rasgulla: await photo('Rasugulla'),
    brownie: await photo('Brownie'),
    iceCream: await photo('ice cream'),
    coldCoffee: await photo('Cold Coffee with ice cream'),
    burger: await photo('burger'),
    tikkiBurger: await photo('Aloo Tikki Burger'),
    pizza: await photo('Pizza'),
    bhel: await photo('chinese bhel'),
};
const restaurantPhotos = await prisma.foodRestaurant.findMany({
    where: { profileImage: { startsWith: 'http' }, status: 'approved' },
    select: { profileImage: true, coverImages: true },
    take: 12,
});
const covers = restaurantPhotos.flatMap((r) => r.coverImages).filter((u) => u?.startsWith('http'));

// ---- categories -----------------------------------------------------------------
// The platform's home categories have no zone, so they already show in Tamil
// Nadu; dishes are filed under them so tapping one finds Tamil Nadu food.
const globalCategory = async (name) =>
    prisma.foodCategory.findFirst({
        where: { restaurantId: null, name: { equals: name, mode: 'insensitive' }, isActive: true },
        select: { id: true, name: true },
    });
const southIndian =
    (await prisma.foodCategory.findFirst({ where: { name: 'South Indian', zoneId: zone.id, restaurantId: null } })) ??
    (await prisma.foodCategory.create({
        data: { name: 'South Indian', image: P.dosa, zoneId: zone.id, isApproved: true, isActive: true, sortOrder: 0 },
    }));
const C = {
    south: southIndian,
    main: await globalCategory('Main Course'),
    breakfast: await globalCategory('Breakfast'),
    snacks: await globalCategory('Snacks'),
    dessert: await globalCategory('Dessert'),
    beverages: await globalCategory('beverages'),
    breads: await globalCategory('Breads'),
    chinese: await globalCategory('Chinese'),
};
console.log('categories:', Object.entries(C).map(([k, v]) => `${k}=${v ? v.name : 'MISSING'}`).join(', '));

// ---- restaurants ------------------------------------------------------------------
const RESTAURANTS = [
    {
        name: 'Chennai Tiffin Centre', phone: '9000011001', lat: 13.0418, lng: 80.2341,
        area: 'T. Nagar', cityName: 'Chennai', pincode: '600017', address: '42 Usman Road, T. Nagar',
        cuisines: ['South Indian', 'Breakfast'], veg: true, eta: '20-25 mins', rating: 4.5, ratings: 312,
        menu: [
            ['Masala Dosa', 90, 'Veg', 'south', 'dosa'], ['Ghee Roast Dosa', 120, 'Veg', 'south', 'dosa'],
            ['Idli Vada Combo', 70, 'Veg', 'breakfast', 'thali'], ['Mini Tiffin', 140, 'Veg', 'breakfast', 'thali'],
            ['Filter Coffee', 40, 'Veg', 'beverages', 'coldCoffee'], ['Rava Kesari', 60, 'Veg', 'dessert', 'jalebi'],
        ],
    },
    {
        name: 'Kovai Biryani House', phone: '9000011002', lat: 11.0168, lng: 76.9558,
        area: 'RS Puram', cityName: 'Coimbatore', pincode: '641002', address: '18 DB Road, RS Puram',
        cuisines: ['Biryani', 'South Indian'], veg: false, eta: '30-35 mins', rating: 4.4, ratings: 268,
        menu: [
            ['Chicken Biryani', 240, 'NonVeg', 'main', 'biryani'], ['Mutton Biryani', 320, 'NonVeg', 'main', 'biryani'],
            ['Veg Biryani', 180, 'Veg', 'main', 'biryani'], ['Chicken 65', 200, 'NonVeg', 'snacks', 'chicken'],
            ['Parotta Salna', 110, 'NonVeg', 'breads', 'paratha'], ['Gulab Jamun', 70, 'Veg', 'dessert', 'gulabJamun'],
        ],
    },
    {
        name: 'Madurai Meenakshi Mess', phone: '9000011003', lat: 9.9252, lng: 78.1198,
        area: 'Town Hall Road', cityName: 'Madurai', pincode: '625001', address: '7 Town Hall Road',
        cuisines: ['South Indian', 'Chettinad'], veg: false, eta: '25-30 mins', rating: 4.6, ratings: 405,
        menu: [
            ['South Indian Meals', 150, 'Veg', 'south', 'thali'], ['Chettinad Chicken', 260, 'NonVeg', 'main', 'butterChicken'],
            ['Kari Dosa', 160, 'NonVeg', 'south', 'dosa'], ['Bun Parotta', 90, 'Veg', 'breads', 'paratha'],
            ['Jigarthanda', 80, 'Veg', 'beverages', 'iceCream'],
        ],
    },
    {
        name: 'Trichy Dosa Corner', phone: '9000011004', lat: 10.7905, lng: 78.7047,
        area: 'Thillai Nagar', cityName: 'Tiruchirappalli', pincode: '620018', address: '11th Cross, Thillai Nagar',
        cuisines: ['South Indian', 'Chinese'], veg: true, eta: '20-25 mins', rating: 4.3, ratings: 190,
        menu: [
            ['Onion Rava Dosa', 110, 'Veg', 'south', 'dosa'], ['Podi Dosa', 100, 'Veg', 'south', 'dosa'],
            ['Veg Fried Rice', 140, 'Veg', 'chinese', 'friedRice'], ['Veg Noodles', 150, 'Veg', 'chinese', 'noodles'],
            ['Paneer Tikka', 220, 'Veg', 'snacks', 'paneerTikka'], ['Badam Milk', 60, 'Veg', 'beverages', 'coldCoffee'],
        ],
    },
    {
        name: 'Salem Spice Kitchen', phone: '9000011005', lat: 11.6643, lng: 78.1460,
        area: 'Fairlands', cityName: 'Salem', pincode: '636016', address: '5 Omalur Main Road, Fairlands',
        cuisines: ['North Indian', 'Fast Food'], veg: false, eta: '25-30 mins', rating: 4.2, ratings: 144,
        menu: [
            ['Butter Chicken', 280, 'NonVeg', 'main', 'butterChicken'], ['Triple Schezwan Rice', 210, 'NonVeg', 'chinese', 'tripleRice'],
            ['Chicken Burger', 150, 'NonVeg', 'snacks', 'burger'], ['Aloo Tikki Burger', 90, 'Veg', 'snacks', 'tikkiBurger'],
            ['Margherita Pizza', 220, 'Veg', 'snacks', 'pizza'], ['Chocolate Brownie', 120, 'Veg', 'dessert', 'brownie'],
        ],
    },
    {
        name: 'Nellai Sweets & Snacks', phone: '9000011006', lat: 8.7139, lng: 77.7567,
        area: 'Palayamkottai', cityName: 'Tirunelveli', pincode: '627002', address: '23 High Ground Road, Palayamkottai',
        cuisines: ['Sweets', 'Snacks'], veg: true, eta: '15-20 mins', rating: 4.7, ratings: 520,
        menu: [
            ['Tirunelveli Halwa', 150, 'Veg', 'dessert', 'jalebi'], ['Rasgulla', 60, 'Veg', 'dessert', 'rasgulla'],
            ['Gulab Jamun', 60, 'Veg', 'dessert', 'gulabJamun'], ['Chinese Bhel', 70, 'Veg', 'snacks', 'bhel'],
            ['Vanilla Ice Cream', 60, 'Veg', 'dessert', 'iceCream'], ['Masala Dosa', 80, 'Veg', 'south', 'dosa'],
        ],
    },
];

let items = 0;
for (const [i, r] of RESTAURANTS.entries()) {
    const derived = deriveRestaurantFields({ restaurantName: r.name, ownerPhone: r.phone, estimatedDeliveryTime: r.eta });
    const location = fromRestaurantLocation({
        latitude: r.lat,
        longitude: r.lng,
        formattedAddress: `${r.address}, ${r.cityName}, Tamil Nadu ${r.pincode}`,
        addressLine1: r.address,
        area: r.area,
        city: r.cityName,
        state: 'Tamil Nadu',
        pincode: r.pincode,
    });
    const pic = restaurantPhotos[i % Math.max(restaurantPhotos.length, 1)];
    const firstDish = P[r.menu[0][4]];
    const data = {
        restaurantName: r.name,
        ownerName: `${r.cityName} Owner`,
        ownerEmail: `owner.${r.phone}@mintofood.com`,
        ownerPhone: r.phone,
        primaryContactNumber: r.phone,
        ...derived,
        ...location,
        zoneId: zone.id,
        deliveryRadiusKm: 50,
        cuisines: r.cuisines,
        openingTime: '08:00',
        closingTime: '23:00',
        openDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        pureVegRestaurant: r.veg,
        isAcceptingOrders: true,
        estimatedDeliveryTime: r.eta,
        featuredDish: r.menu[0][0],
        featuredPrice: r.menu[0][1],
        rating: r.rating,
        totalRatings: r.ratings,
        profileImage: pic?.profileImage || firstDish || '',
        coverImages: [firstDish, covers[i % Math.max(covers.length, 1)]].filter((u) => u?.startsWith('http')),
        status: 'approved',
        approvedAt: new Date(),
    };
    const restaurant = await prisma.foodRestaurant.upsert({
        where: {
            restaurantNameNormalized_ownerPhoneLast10: {
                restaurantNameNormalized: derived.restaurantNameNormalized,
                ownerPhoneLast10: derived.ownerPhoneLast10,
            },
        },
        create: data,
        update: data,
    });

    for (const [dish, price, foodType, cat, img] of r.menu) {
        const category = C[cat];
        const image = P[img] || '';
        const payload = {
            restaurantId: restaurant.id,
            name: dish,
            price,
            foodType,
            categoryId: category?.id || null,
            categoryName: category?.name || '',
            image,
            images: image ? [image] : [],
            isAvailable: true,
            approvalStatus: 'approved',
        };
        const found = await prisma.foodItem.findFirst({ where: { restaurantId: restaurant.id, name: dish } });
        if (found) await prisma.foodItem.update({ where: { id: found.id }, data: payload });
        else await prisma.foodItem.create({ data: payload });
        items += 1;
    }

    const [inside] = await prisma.$queryRaw`
        SELECT ST_Contains(z.boundary::geometry, ST_SetSRID(ST_MakePoint(${r.lng}, ${r.lat}), 4326)) AS inside
        FROM food_zones z WHERE z.id = ${zone.id}`;
    console.log(`restaurant: ${r.name} (${r.cityName}) id=${restaurant.id} inZone=${inside?.inside} dishes=${r.menu.length}`);
}
console.log(`menu items: ${items}`);

await invalidateActiveZonesCache().catch(() => {});
await invalidateCache('restaurants:*').catch(() => {});
await invalidateCache('restaurant_detail:*').catch(() => {});
await invalidateCache('categories*').catch(() => {});
await prisma.$disconnect();
process.exit(0);
