import type { Settings } from './lib/settings';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Typed once on /setup to create the first owner account. */
  SETUP_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional: Claude model for reply drafts (default claude-sonnet-5-5). */
  AI_MODEL?: string;
  RESEND_API_KEY?: string;
  /** Shared with the cron Worker, which sends it to POST /api/cron. */
  CRON_SECRET?: string;
  /** Optional: 32 random bytes, base64. Encrypts stored OAuth tokens and two-step sign-in keys. */
  ENCRYPTION_KEY?: string;
  /** Optional: PBKDF2 rounds for new password hashes (default 20000, sized for the Workers free plan). */
  PASSWORD_ITERATIONS?: string;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'manager';
  totp_enabled: number;
}

export interface Tech {
  id: string;
  slug: string;
  name: string;
  first_name: string;
  role: string;
  aliases: string;
  email: string | null;
  phone: string | null;
  photo: string | null;
  active: number;
  sort: number;
  password_hash: string | null; // set by the tech from their invite link
  invite_hash: string | null;
  invite_expires_at: number | null;
  home_location: string | null; // settings.locations id
  today_location: string | null; // set from the tech app; only counts on the day in today_on
  today_on: string | null; // YYYY-MM-DD, company time zone
  created_at: number;
  updated_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    settings: Settings;
    admin: AdminUser;
    tech: Tech;
    /** Hash of this session's cookie token, so "signed-in devices" can mark "this device". */
    sessionId: string;
  };
};
