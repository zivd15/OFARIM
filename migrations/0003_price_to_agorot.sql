-- Migration 0003: Convert event prices from ILS to AGOROT (×100)
--   npx wrangler d1 execute ofarim --file=migrations/0003_price_to_agorot.sql --remote
--
-- ⚠️  RUN EXACTLY ONCE. Prices are now stored in agorot (₪50 -> 5000) so external
-- payment gateways stay integer-exact. This rescales any price that was entered
-- under migration 0002 (where the column briefly held whole ILS).
-- If every event still has price = 0 (nothing priced yet) this is a harmless no-op.
-- Do NOT re-run: a second pass would multiply prices by 100 again.

UPDATE events SET price = price * 100 WHERE price > 0;
