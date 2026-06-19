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
