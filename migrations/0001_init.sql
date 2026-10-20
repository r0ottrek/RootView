-- RootView: initial schema. Apply with `npm run db:migrate` (local) or `npm run db:migrate:remote`.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY, -- keys starting with "_" hold secrets (OAuth tokens) and never reach a page
  value TEXT NOT NULL      -- JSON
);

-- Office logins.
CREATE TABLE admins (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,              -- NULL until an invited manager sets one
  role          TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('owner', 'manager')),
  invite_hash       TEXT,          -- sha256 of a one-time "set your password" link
  invite_expires_at INTEGER,
  totp_secret   TEXT,              -- two-step sign-in (authenticator app); encrypted when ENCRYPTION_KEY is set
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,          -- last accepted 30-second step, so a code can't be used twice
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Everyone who carries a review tag. Each tech has their own login to the tech app (/me).
CREATE TABLE techs (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE COLLATE NOCASE, -- https://reviews.example.com/<slug>; also their username
  name              TEXT NOT NULL,
  first_name        TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'Technician',
  aliases           TEXT NOT NULL DEFAULT '',            -- other names customers use, comma separated
  email             TEXT,
  phone             TEXT,
  photo             TEXT,                                -- data:image/jpeg;base64,... (320px square)
  active            INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 100,
  password_hash     TEXT,                                -- set by the tech from a one-time invite link
  invite_hash       TEXT,                                -- sha256 of the current invite token
  invite_expires_at INTEGER,
  home_location     TEXT,                                -- settings.locations id
  today_location    TEXT,                                -- the tech's pick for today (only counts on today_on)
  today_on          TEXT,                                -- YYYY-MM-DD in the company time zone
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Signed-in browsers. The cookie holds a random token; only its sha256 is stored here.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('admin', 'tech', 'mfa')), -- mfa = password checked, waiting for the 6-digit code
  subject_id   TEXT NOT NULL,
  label        TEXT,             -- "iPhone · Safari": shown in "signed-in devices"
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_subject ON sessions (kind, subject_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Fixed-window counters for sign-in throttling and public-form rate limits. Old rows are cleared by the scheduler.
CREATE TABLE throttle (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Uploaded logo and app icons (validated images, base64).
CREATE TABLE assets (
  name       TEXT PRIMARY KEY, -- logo | icon-512 | icon-192 | icon-180 | icon-32
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per customer visit to a tech's page (NFC tap, QR scan or texted link).
CREATE TABLE taps (
  id              TEXT PRIMARY KEY,
  tech_id         TEXT REFERENCES techs (id) ON DELETE SET NULL,
  source          TEXT NOT NULL DEFAULT 'link', -- nfc | qr | text | link | picker
  customer_name   TEXT,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  site            TEXT,    -- review site button pressed: google | yelp | bbb | facebook
  location_id     TEXT,    -- the Google profile the button pointed at (settings.locations)
  location_how    TEXT,    -- tech_today | customer_area | tech_home | main
  geo             TEXT,    -- rough area from the customer's connection, e.g. "Springfield 62701"
  created_at      INTEGER NOT NULL,
  rated_at        INTEGER,
  clicked_at      INTEGER,
  review_id       TEXT,    -- the public review this visit turned into
  resolved_at     INTEGER, -- low rating followed up
  resolved_by     TEXT,
  callback_phone  TEXT,    -- low ratings can ask for a call-back
  callback_time   TEXT,    -- asap | morning | afternoon | evening
  callback_at     INTEGER,
  followup_status TEXT,    -- called | resolved | unresolved (NULL = not contacted yet)
  followup_note   TEXT,
  followup_at     INTEGER,
  followup_by     TEXT
);
CREATE INDEX taps_tech_time ON taps (tech_id, created_at);
CREATE INDEX taps_time ON taps (created_at);
CREATE INDEX taps_open_low ON taps (rating) WHERE resolved_at IS NULL AND rating IS NOT NULL; -- the "low ratings to follow up" badge

-- Public reviews (pulled from Google, or entered by hand for Yelp, BBB and others).
CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,          -- google | yelp | bbb | facebook | other
  external_id    TEXT,
  resource_name  TEXT,                   -- Google API name, used to post replies
  location       TEXT,                   -- Google profile title, for display
  location_id    TEXT,                   -- Google profile id ('locations/123')
  reviewer_name  TEXT NOT NULL DEFAULT '',
  reviewer_photo TEXT,
  rating         INTEGER,
  body           TEXT NOT NULL DEFAULT '',
  posted_at      INTEGER NOT NULL,
  updated_at     INTEGER,
  imported_at    INTEGER NOT NULL,
  reply          TEXT,
  reply_at       INTEGER,
  reply_draft    TEXT,
  reply_error    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | credited | unassigned | not_tech | history
  suggestions    TEXT,                   -- JSON: possible techs when not sure
  alerted_at     INTEGER,
  UNIQUE (platform, external_id)
);
CREATE INDEX reviews_posted ON reviews (posted_at);
CREATE INDEX reviews_status ON reviews (status, posted_at);

-- Which tech(s) got credit for a review, and why.
CREATE TABLE credits (
  review_id  TEXT NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  tech_id    TEXT NOT NULL REFERENCES techs (id) ON DELETE CASCADE,
  method     TEXT NOT NULL,  -- tap | mention | tap+mention | timing | manual
  score      INTEGER NOT NULL DEFAULT 0,
  evidence   TEXT,
  tap_id     TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (review_id, tech_id)
);
CREATE INDEX credits_tech ON credits (tech_id);

-- Points ledger. Balance = SUM(amount).
CREATE TABLE points (
  id            TEXT PRIMARY KEY,
  tech_id       TEXT NOT NULL REFERENCES techs (id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  review_id     TEXT,
  tap_id        TEXT,
  redemption_id TEXT,
  created_by    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX points_tech ON points (tech_id, created_at);
CREATE INDEX points_review ON points (review_id);
-- A review pays each tech each kind of points once, even if two matching runs overlap.
CREATE UNIQUE INDEX points_review_once ON points (review_id, tech_id, reason) WHERE review_id IS NOT NULL;

CREATE TABLE rewards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cost        INTEGER NOT NULL CHECK (cost > 0),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE redemptions (
  id          TEXT PRIMARY KEY,
  tech_id     TEXT NOT NULL REFERENCES techs (id) ON DELETE CASCADE,
  reward_id   TEXT REFERENCES rewards (id) ON DELETE SET NULL,
  reward_name TEXT NOT NULL,
  cost        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'requested', -- requested | approved | fulfilled | denied
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT
);
CREATE INDEX redemptions_status ON redemptions (status, created_at);

-- Who changed what in the office dashboard (settings, Google, users, points, deletions). Owners see it in Settings.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  admin_id   TEXT,
  admin_name TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_time ON audit_log (created_at);
