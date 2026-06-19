CREATE TABLE IF NOT EXISTS ecdict_words (
  word TEXT PRIMARY KEY,
  phonetic TEXT,
  translation TEXT,
  definition TEXT,
  pos TEXT,
  exchange TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS word_cache (
  term TEXT PRIMARY KEY,
  canonical_word TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_word_cache_expires_at
  ON word_cache (expires_at);

CREATE TABLE IF NOT EXISTS word_aliases (
  alias_term TEXT PRIMARY KEY,
  canonical_term TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_word_aliases_canonical
  ON word_aliases (canonical_term);

INSERT OR IGNORE INTO word_aliases
  (alias_term, canonical_term, source, created_at, updated_at)
SELECT
  term,
  LOWER(TRIM(canonical_word)),
  'word_cache_backfill',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM word_cache
WHERE canonical_word IS NOT NULL
  AND TRIM(canonical_word) != ''
  AND LENGTH(TRIM(canonical_word)) <= 64
  AND LOWER(TRIM(canonical_word)) != term;

CREATE TABLE IF NOT EXISTS lookup_failures (
  term TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key TEXT NOT NULL,
  target_language TEXT NOT NULL,
  input_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (cache_key, target_language)
);

CREATE TABLE IF NOT EXISTS translation_usage (
  source TEXT NOT NULL,
  usage_month TEXT NOT NULL,
  characters_used INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, usage_month)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS verified_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verified_emails_user
  ON verified_emails (user_id);

CREATE TABLE IF NOT EXISTS auth_email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_email_codes_lookup
  ON auth_email_codes (email, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_user_words (
  user_id TEXT NOT NULL,
  word TEXT NOT NULL,
  familiarity INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 1,
  source_type TEXT,
  source_name TEXT,
  added_at TEXT NOT NULL,
  review_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, word)
);

CREATE INDEX IF NOT EXISTS idx_cloud_user_words_user_added
  ON cloud_user_words (user_id, added_at DESC);
