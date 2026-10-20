-- Indexes for the daily clean-up, deleting visits, and refunds, so D1's "rows read" stays low as data grows.
-- Applied by `npm run dev` (local) or `npm run db:migrate:remote`.
CREATE INDEX IF NOT EXISTS taps_review ON taps (review_id);
CREATE INDEX IF NOT EXISTS taps_geo_time ON taps (created_at) WHERE geo IS NOT NULL;
CREATE INDEX IF NOT EXISTS taps_callback ON taps (callback_at) WHERE callback_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS taps_unfinished ON taps (created_at) WHERE rating IS NULL AND review_id IS NULL;
CREATE INDEX IF NOT EXISTS points_tap ON points (tap_id);
CREATE INDEX IF NOT EXISTS points_redemption ON points (redemption_id);
CREATE INDEX IF NOT EXISTS points_time ON points (created_at);
CREATE INDEX IF NOT EXISTS credits_tap ON credits (tap_id);
CREATE INDEX IF NOT EXISTS throttle_window ON throttle (window_start);
