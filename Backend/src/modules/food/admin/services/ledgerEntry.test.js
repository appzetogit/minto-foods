import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Recording money that did not come from an order.
 *
 * Mirrors the validation in adminLedgerEntry.service.js. These figures land on
 * the balance sheet beside numbers derived from real orders, so a sloppy entry
 * is not a bad form field — it is a books total that no longer reconciles.
 */

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

const readAmount = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new Error('Amount must be a number');
    if (amount <= 0) throw new Error('Amount must be more than zero');
    if (amount > 100000000) throw new Error('That amount looks wrong');
    return money(amount);
};

const readType = (value) => {
    const type = String(value || '').trim().toLowerCase();
    if (type !== 'income' && type !== 'expense') throw new Error('Type must be income or expense');
    return type;
};

const rejects = (fn) => {
    try { fn(); return null; } catch (e) { return e.message; }
};

test('direction comes from the type, so the amount is always positive', () => {
    // A negative expense is an income wearing a disguise. Two ways to say the
    // same thing is two ways to get a total wrong.
    assert.ok(rejects(() => readAmount(-500)));
    assert.ok(rejects(() => readAmount(0)));
    assert.equal(readAmount(500), 500);
});

test('a non-number is refused rather than becoming zero', () => {
    // Number("") is 0 and Number("abc") is NaN. Silently recording ₹0 would put
    // a meaningless row on the books.
    for (const bad of ['', 'abc', null, undefined, {}, NaN, Infinity]) {
        assert.ok(rejects(() => readAmount(bad)), JSON.stringify(bad));
    }
});

test('paise survive, and nothing beyond them', () => {
    assert.equal(readAmount('1250.75'), 1250.75);
    assert.equal(readAmount(10.005), 10.01);
    assert.equal(readAmount(0.014), 0.01);
});

test('an implausible amount is stopped', () => {
    // A slipped decimal or a pasted phone number should not silently become a
    // ten-crore expense.
    assert.ok(rejects(() => readAmount(1e9)));
});

test('only the two types are accepted', () => {
    assert.equal(readType('income'), 'income');
    assert.equal(readType('EXPENSE'), 'expense');
    assert.equal(readType('  Income  '), 'income');
    for (const bad of ['transfer', '', null, 'refund']) {
        assert.ok(rejects(() => readType(bad)), String(bad));
    }
});

/**
 * The period window.
 *
 * Two traps, and the first one bit while writing these tests.
 *
 * `new Date('2026-09-30')` is midnight **UTC**, which in IST is half past five
 * on the morning of the 30th — so a period built from bare dates was shifted by
 * the whole UTC offset, dropping the last evening of the month and pulling in
 * the early hours of the next. A bare date has to be read as a *local* one.
 *
 * And the day after `to` is reached by moving the calendar date, not by adding
 * 24 hours, so a DST change cannot move the boundary.
 */
const readDate = (raw) => {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
    return dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : new Date(raw);
};

const nextLocalDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

const windowFor = (from, to) => ({
    gte: readDate(from),
    lt: nextLocalDay(readDate(to)),
});

test('a bare date is read in local time, not UTC', () => {
    // The bug this replaced: parsed as UTC, a September period in IST began at
    // 05:30 on the 1st and ended at 05:30 on the 1st of October.
    const d = readDate('2026-09-30');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 30);
    assert.equal(d.getHours(), 0);
});

test('an entry recorded late on the last day is still in the period', () => {
    const w = windowFor('2026-09-01', '2026-09-30');
    assert.ok(new Date(2026, 8, 30, 22, 15) >= w.gte);
    assert.ok(new Date(2026, 8, 30, 22, 15) < w.lt);
});

test('an entry in the first minutes of the next day is out', () => {
    const w = windowFor('2026-09-01', '2026-09-30');
    assert.ok(new Date(2026, 9, 1, 0, 0, 1) >= w.lt);
});

test('an entry at the very start of the first day is in', () => {
    const w = windowFor('2026-09-01', '2026-09-30');
    assert.ok(new Date(2026, 8, 1, 0, 0, 0) >= w.gte);
});

test('a single-day period covers exactly that day', () => {
    const w = windowFor('2026-09-15', '2026-09-15');
    assert.ok(new Date(2026, 8, 15, 12, 0) >= w.gte);
    assert.ok(new Date(2026, 8, 15, 23, 59, 59) < w.lt);
    assert.ok(new Date(2026, 8, 14, 23, 59, 59) < w.gte);
    assert.ok(new Date(2026, 8, 16, 0, 0, 1) >= w.lt);
});

test('a date carrying a time is taken at that time', () => {
    // The caller already said what they meant; do not floor it to midnight.
    const d = readDate('2026-09-30T14:30:00');
    assert.equal(d.getHours(), 14);
    assert.equal(d.getMinutes(), 30);
});

/** Totals reported beside the derived figures, never folded into them. */
const totals = (entries) => {
    const sum = (type) =>
        money(entries.filter((e) => e.type === type).reduce((n, e) => n + e.amount, 0));
    const income = sum('income');
    const expense = sum('expense');
    return { income, expense, net: money(income - expense) };
};

test('income and expense are reported separately as well as netted', () => {
    // A single net figure hides whether a month had no activity or had equal
    // amounts of both.
    const out = totals([
        { type: 'income', amount: 5000 },
        { type: 'expense', amount: 1200.5 },
        { type: 'expense', amount: 800 },
    ]);
    assert.deepEqual(out, { income: 5000, expense: 2000.5, net: 2999.5 });
});

test('net goes negative when more went out than came in', () => {
    const out = totals([{ type: 'expense', amount: 900 }, { type: 'income', amount: 100 }]);
    assert.equal(out.net, -800);
});

test('an empty period is zeroes, not an absent total', () => {
    assert.deepEqual(totals([]), { income: 0, expense: 0, net: 0 });
});
