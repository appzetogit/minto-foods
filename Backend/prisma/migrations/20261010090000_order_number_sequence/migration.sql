-- Order numbers: MFB + DDMMYY + a running number that never resets.
-- A sequence, so two orders placed at the same moment can never share one.
CREATE SEQUENCE IF NOT EXISTS "food_order_number_seq" START WITH 10001 INCREMENT BY 1 NO CYCLE;
