-- Tracking links (Links in the office menu): a named short link and QR code for anywhere you ask for reviews
-- (your CRM's texts, invoices, emails, yard signs, your website), and which visits and reviews each one brought in.
-- Applied by `npm run dev` (local) or `npm run db:migrate:remote`.

CREATE TABLE links (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- the address: /r/<code>. Never changes, so printed QR codes keep working
  name        TEXT NOT NULL,            -- what the office calls it: "Invoice emails"
  tech_id     TEXT REFERENCES techs (id) ON DELETE SET NULL, -- one tech's link, or NULL: the customer picks their tech
  dest        TEXT NOT NULL DEFAULT 'rate' CHECK (dest IN ('rate', 'google')), -- the rating page first, or straight to Google
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER                   -- hidden from the list; the link itself keeps working
);

-- Each time a link's first page was actually on someone's screen (link scanners and previews don't count).
-- Nothing about the person is stored.
CREATE TABLE link_opens (
  id         TEXT PRIMARY KEY,
  link_id    TEXT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX link_opens_link_time ON link_opens (link_id, created_at);

-- The visit a link led to; its rating, review-site click and matched review follow from the visit.
ALTER TABLE taps ADD COLUMN link_id TEXT REFERENCES links (id) ON DELETE SET NULL;
CREATE INDEX taps_link ON taps (link_id) WHERE link_id IS NOT NULL;
