const FREE_DICTIONARY_BASE_URL = "https://api.dictionaryapi.dev/api/v2/entries/en";
const DATAMUSE_BASE_URL = "https://api.datamuse.com/words";
const GOOGLE_TRANSLATE_BASE_URL = "https://translation.googleapis.com/language/translate/v2";
const GOOGLE_TRANSLATE_SOURCE = "google_cloud_translation";
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_GOOGLE_TRANSLATE_MONTHLY_LIMIT = 450000;
const REQUEST_TIMEOUT_MS = 7000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "en-learning-dictionary",
          hasDatabase: Boolean(env.DB),
          hasGoogleTranslate: Boolean(env.DB && env.GOOGLE_TRANSLATE_API_KEY),
          googleTranslateMonthlyLimit: getGoogleTranslateMonthlyLimit(env),
        });
      }

      if (request.method === "GET" && url.pathname === "/translation-usage") {
        const usage = await readCurrentTranslationUsage(env.DB, env);
        return jsonResponse({
          ok: true,
          usage,
        });
      }

      if (request.method === "GET" && url.pathname === "/word") {
        const term = url.searchParams.get("term");
        const refresh = isTruthy(url.searchParams.get("refresh"));
        const result = await lookupWord(term, env, { refresh });
        return jsonResponse(result);
      }

      if (request.method === "POST" && url.pathname === "/batch-words") {
        const body = await readJson(request);
        const terms = Array.isArray(body?.terms) ? body.terms : [];
        const refresh = Boolean(body?.refresh);
        const result = await lookupBatch(terms, env, { refresh });
        return jsonResponse(result);
      }

      return jsonResponse(
        {
          ok: false,
          error: {
            code: "not_found",
            message: "Endpoint not found.",
          },
        },
        404,
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : "Unknown error.",
          },
        },
        500,
      );
    }
  },
};

async function lookupBatch(rawTerms, env, options) {
  const limit = getNumber(env.BATCH_LIMIT, DEFAULT_BATCH_LIMIT);
  const normalizedTerms = [];
  const rejected = [];
  const seen = new Set();

  for (const rawTerm of rawTerms) {
    const validation = validateTerm(rawTerm);
    if (!validation.ok) {
      rejected.push({
        input: rawTerm,
        reason: validation.reason,
      });
      continue;
    }

    if (!seen.has(validation.term)) {
      seen.add(validation.term);
      normalizedTerms.push(validation.term);
    }
  }

  const limitedTerms = normalizedTerms.slice(0, limit);
  const skipped = normalizedTerms.slice(limit);
  const entries = [];

  for (const term of limitedTerms) {
    entries.push(await lookupWord(term, env, options));
  }

  return {
    ok: true,
    requestedCount: rawTerms.length,
    acceptedCount: limitedTerms.length,
    rejectedCount: rejected.length,
    skippedCount: skipped.length,
    rejected,
    skipped,
    entries,
  };
}

async function lookupWord(rawTerm, env, options = {}) {
  const validation = validateTerm(rawTerm);
  if (!validation.ok) {
    return {
      ok: false,
      term: rawTerm ?? "",
      status: "invalid",
      error: {
        code: "invalid_term",
        message: validation.reason,
      },
    };
  }

  const term = validation.term;

  if (!options.refresh) {
    const cached = await readWordCache(env.DB, term);
    if (cached) {
      return {
        ...cached,
        ok: true,
        fromCache: true,
        cacheStatus: "fresh",
      };
    }
  }

  const [ecdictResult, freeDictionaryResult, synonymsResult, nearSynonymsResult] =
    await Promise.allSettled([
      readEcdictWord(env.DB, term),
      fetchFreeDictionary(term),
      fetchDatamuse(term, "synonyms", env),
      fetchDatamuse(term, "nearSynonyms", env),
    ]);

  const ecdict = settledValue(ecdictResult);
  const freeDictionary = settledValue(freeDictionaryResult);
  const synonyms = settledValue(synonymsResult) ?? [];
  const nearSynonyms = settledValue(nearSynonymsResult) ?? [];
  const firstFreeEntry = Array.isArray(freeDictionary) ? freeDictionary[0] : null;
  const definitions = extractDefinitions(firstFreeEntry);
  const errors = [
    settledError("free_dictionary", freeDictionaryResult),
    settledError("datamuse_synonyms", synonymsResult),
    settledError("datamuse_near_synonyms", nearSynonymsResult),
  ].filter(Boolean);

  let googleTranslation = null;
  const translationResult = await tryTranslateTextWithGoogle(term, env, "word");
  if (translationResult.ok) {
    googleTranslation = translationResult.translation;
  } else if (translationResult.error) {
    errors.push(translationResult.error);
  }

  const exampleTranslations = new Map();
  const firstExample = definitions.find((item) => item.example)?.example ?? "";
  if (firstExample) {
    const exampleTranslationResult = await tryTranslateTextWithGoogle(firstExample, env, "example");
    if (exampleTranslationResult.ok) {
      exampleTranslations.set(firstExample, exampleTranslationResult.translation);
    } else if (exampleTranslationResult.error) {
      errors.push(exampleTranslationResult.error);
    }
  }

  const payload = buildWordPayload({
    term,
    ecdict,
    freeDictionary,
    definitions,
    googleTranslation,
    exampleTranslations,
    synonyms,
    nearSynonyms,
    errors,
  });

  await writeWordCache(env.DB, payload, env);

  if (payload.status === "not_found" || payload.status === "pending") {
    await recordLookupFailure(env.DB, term, payload.missing.join(",") || "not_found");
  }

  return payload;
}

async function tryTranslateTextWithGoogle(inputText, env, purpose) {
  try {
    return await translateTextWithGoogle(inputText, env, purpose);
  } catch (error) {
    return {
      ok: false,
      error: {
        source: GOOGLE_TRANSLATE_SOURCE,
        message: error instanceof Error ? error.message : "Google 翻譯呼叫失敗。",
      },
    };
  }
}

function buildWordPayload({
  term,
  ecdict,
  freeDictionary,
  definitions,
  googleTranslation,
  exampleTranslations,
  synonyms,
  nearSynonyms,
  errors,
}) {
  const firstFreeEntry = Array.isArray(freeDictionary) ? freeDictionary[0] : null;
  const examples = definitions
    .filter((item) => item.example)
    .map((item) => ({
      text: item.example,
      translation: exampleTranslations.get(item.example)?.text ?? "",
      translationSource: exampleTranslations.get(item.example)?.source ?? "",
      source: item.source,
    }));
  const phonetics = extractPhonetics(firstFreeEntry);
  const phonetic = ecdict?.phonetic || phonetics.find((item) => item.text)?.text || "";
  const partsOfSpeech = uniqueStrings([
    ...splitPartsOfSpeech(ecdict?.pos),
    ...definitions.map((item) => item.partOfSpeech).filter(Boolean),
  ]);
  const translations = [];
  if (googleTranslation?.text) {
    translations.push({
      text: googleTranslation.text,
      source: googleTranslation.source,
    });
  } else if (ecdict?.translation) {
    translations.push({
      text: ecdict.translation,
      source: "ecdict_d1_fallback",
    });
  }
  const englishDefinitions = [
    ...(ecdict?.definition
      ? [
          {
            partOfSpeech: ecdict?.pos || "",
            definition: ecdict.definition,
            example: "",
            source: "ecdict_d1",
          },
        ]
      : []),
    ...definitions,
  ];
  const canonicalWord = firstFreeEntry?.word || ecdict?.word || term;
  const missing = [];

  if (!translations.length) {
    missing.push("translation");
  }
  if (!phonetic) {
    missing.push("phonetic");
  }
  if (!englishDefinitions.length) {
    missing.push("definition");
  }
  if (!examples.length) {
    missing.push("examples");
  }
  if (!synonyms.length) {
    missing.push("synonyms");
  }
  if (!nearSynonyms.length) {
    missing.push("nearSynonyms");
  }

  const hasAnyMeaning = translations.length || englishDefinitions.length;
  const status = hasAnyMeaning
    ? missing.length
      ? "partial"
      : "complete"
    : "pending";

  return {
    ok: true,
    term,
    normalizedTerm: term,
    status,
    fromCache: false,
    updatedAt: new Date().toISOString(),
    missing,
    errors,
    entry: {
      word: canonicalWord,
      canonicalWord,
      phonetic,
      phonetics,
      partsOfSpeech,
      translations,
      definitions: englishDefinitions,
      examples: uniqueByText(examples),
      synonyms: uniqueStrings(synonyms).slice(0, 20),
      nearSynonyms: uniqueStrings(nearSynonyms).slice(0, 20),
      source: {
        translation: translations.length ? translations[0].source : "pending",
        definition: definitions.length ? "free_dictionary" : ecdict?.definition ? "ecdict_d1" : "pending",
        synonyms: synonyms.length ? "datamuse" : "pending",
        nearSynonyms: nearSynonyms.length ? "datamuse" : "pending",
      },
    },
  };
}

async function translateTextWithGoogle(inputText, env, purpose) {
  if (!env.GOOGLE_TRANSLATE_API_KEY) {
    return { ok: false };
  }

  if (!env.DB) {
    return {
      ok: false,
      error: {
        source: GOOGLE_TRANSLATE_SOURCE,
        message: "Google 翻譯已設定金鑰，但缺少 D1，為避免無法控管用量所以略過。",
      },
    };
  }

  const text = String(inputText ?? "").trim();
  if (!text) {
    return { ok: false };
  }

  const cacheKey = await createTranslationCacheKey(purpose, text);
  const cached = await readTranslationCache(env.DB, cacheKey, "zh-TW");
  if (cached) {
    return {
      ok: true,
      translation: {
        text: cached.translated_text,
        source: "google_cloud_translation_cache",
      },
    };
  }

  const characterCount = countCharacters(text);
  const reservation = await reserveGoogleTranslationUsage(env.DB, env, characterCount);
  if (!reservation.ok) {
    return {
      ok: false,
      error: {
        source: GOOGLE_TRANSLATE_SOURCE,
        message: `本月 Google 翻譯用量已達保護上限 ${reservation.limit} 字元，已停止呼叫以避免扣款。`,
      },
    };
  }

  const response = await fetchWithTimeout(
    `${GOOGLE_TRANSLATE_BASE_URL}?key=${encodeURIComponent(env.GOOGLE_TRANSLATE_API_KEY)}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "EN-Learning-Worker/0.1",
      },
      body: JSON.stringify({
        q: [text],
        source: "en",
        target: "zh-TW",
        format: "text",
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Translation returned ${response.status}: ${body}`);
  }

  const data = await response.json();
  const translatedText = data?.data?.translations?.[0]?.translatedText ?? "";
  const decoded = decodeHtmlEntities(translatedText);
  const cleaned = purpose === "word"
    ? cleanChineseMeaning(decoded)
    : cleanTranslatedSentence(decoded);
  if (!cleaned || cleaned.toLowerCase() === text.toLowerCase()) {
    return { ok: false };
  }

  await writeTranslationCache(env.DB, cacheKey, "zh-TW", text, cleaned, GOOGLE_TRANSLATE_SOURCE);

  return {
    ok: true,
    translation: {
      text: cleaned,
      source: GOOGLE_TRANSLATE_SOURCE,
      usage: {
        month: reservation.month,
        charactersReserved: characterCount,
        charactersUsed: reservation.charactersUsed,
        monthlyLimit: reservation.limit,
      },
    },
  };
}

async function readTranslationCache(db, term, targetLanguage) {
  if (!db) {
    return null;
  }

  return await db
    .prepare(
      `SELECT translated_text, source, updated_at
       FROM translation_cache
       WHERE cache_key = ? AND target_language = ?
       LIMIT 1`,
    )
    .bind(term, targetLanguage)
    .first();
}

async function writeTranslationCache(db, cacheKey, targetLanguage, inputText, translatedText, source) {
  if (!db) {
    return;
  }

  await db
    .prepare(
      `INSERT INTO translation_cache (cache_key, target_language, input_text, translated_text, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key, target_language) DO UPDATE SET
         input_text = excluded.input_text,
         translated_text = excluded.translated_text,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .bind(cacheKey, targetLanguage, inputText, translatedText, source, new Date().toISOString())
    .run();
}

async function reserveGoogleTranslationUsage(db, env, characterCount) {
  const limit = getGoogleTranslateMonthlyLimit(env);
  const month = currentUsageMonth();
  const now = new Date().toISOString();

  if (characterCount <= 0 || characterCount > limit) {
    const current = await readTranslationUsage(db, GOOGLE_TRANSLATE_SOURCE, month);
    return {
      ok: false,
      month,
      limit,
      charactersUsed: current.characters_used ?? 0,
    };
  }

  const reserved = await db
    .prepare(
      `INSERT INTO translation_usage (source, usage_month, characters_used, request_count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(source, usage_month) DO UPDATE SET
         characters_used = characters_used + excluded.characters_used,
         request_count = request_count + 1,
         updated_at = excluded.updated_at
       WHERE characters_used + excluded.characters_used <= ?
       RETURNING characters_used, request_count`,
    )
    .bind(GOOGLE_TRANSLATE_SOURCE, month, characterCount, now, limit)
    .first();

  if (!reserved) {
    const current = await readTranslationUsage(db, GOOGLE_TRANSLATE_SOURCE, month);
    return {
      ok: false,
      month,
      limit,
      charactersUsed: current.characters_used ?? 0,
      requestCount: current.request_count ?? 0,
    };
  }

  return {
    ok: true,
    month,
    limit,
    charactersUsed: reserved.characters_used,
    requestCount: reserved.request_count,
  };
}

async function readCurrentTranslationUsage(db, env) {
  const limit = getGoogleTranslateMonthlyLimit(env);
  const month = currentUsageMonth();

  if (!db) {
    return {
      source: GOOGLE_TRANSLATE_SOURCE,
      month,
      charactersUsed: 0,
      requestCount: 0,
      monthlyLimit: limit,
      remainingCharacters: limit,
      trackingEnabled: false,
    };
  }

  const row = await readTranslationUsage(db, GOOGLE_TRANSLATE_SOURCE, month);
  const charactersUsed = row.characters_used ?? 0;
  return {
    source: GOOGLE_TRANSLATE_SOURCE,
    month,
    charactersUsed,
    requestCount: row.request_count ?? 0,
    monthlyLimit: limit,
    remainingCharacters: Math.max(limit - charactersUsed, 0),
    trackingEnabled: true,
  };
}

async function readTranslationUsage(db, source, month) {
  if (!db) {
    return {};
  }

  const row = await db
    .prepare(
      `SELECT characters_used, request_count, updated_at
       FROM translation_usage
       WHERE source = ? AND usage_month = ?
       LIMIT 1`,
    )
    .bind(source, month)
    .first();

  return row ?? {};
}

async function readEcdictWord(db, term) {
  if (!db) {
    return null;
  }

  const row = await db
    .prepare(
      `SELECT word, phonetic, translation, definition, pos, exchange
       FROM ecdict_words
       WHERE word = ?
       LIMIT 1`,
    )
    .bind(term)
    .first();

  return row ?? null;
}

async function readWordCache(db, term) {
  if (!db) {
    return null;
  }

  const row = await db
    .prepare(
      `SELECT payload_json
       FROM word_cache
       WHERE term = ? AND expires_at > ?
       LIMIT 1`,
    )
    .bind(term, new Date().toISOString())
    .first();

  if (!row?.payload_json) {
    return null;
  }

  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

async function writeWordCache(db, payload, env) {
  if (!db) {
    return;
  }

  const now = new Date();
  const ttlSeconds = getNumber(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS);
  const expiresAt = new Date(
    now.getTime() + ttlSeconds * 1000,
  ).toISOString();

  await db
    .prepare(
      `INSERT INTO word_cache (term, canonical_word, status, payload_json, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET
         canonical_word = excluded.canonical_word,
         status = excluded.status,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .bind(
      payload.normalizedTerm,
      payload.entry.canonicalWord,
      payload.status,
      JSON.stringify(payload),
      now.toISOString(),
      expiresAt,
    )
    .run();
}

async function recordLookupFailure(db, term, reason) {
  if (!db) {
    return;
  }

  await db
    .prepare(
      `INSERT INTO lookup_failures (term, reason, last_failed_at, retry_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(term) DO UPDATE SET
         reason = excluded.reason,
         last_failed_at = excluded.last_failed_at,
         retry_count = retry_count + 1`,
    )
    .bind(term, reason, new Date().toISOString())
    .run();
}

async function fetchFreeDictionary(term) {
  const response = await fetchWithTimeout(
    `${FREE_DICTIONARY_BASE_URL}/${encodeURIComponent(term)}`,
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Free Dictionary returned ${response.status}.`);
  }

  return response.json();
}

async function fetchDatamuse(term, type, env) {
  const params = new URLSearchParams();

  if (type === "synonyms") {
    params.set("rel_syn", term);
  } else {
    params.set("ml", term);
  }

  params.set("max", "20");

  if (env.DATAMUSE_API_KEY) {
    params.set("key", env.DATAMUSE_API_KEY);
  }

  const response = await fetchWithTimeout(`${DATAMUSE_BASE_URL}?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Datamuse returned ${response.status}.`);
  }

  const data = await response.json();
  return Array.isArray(data)
    ? data
        .map((item) => item.word)
        .filter((word) => typeof word === "string" && word.trim())
    : [];
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": "EN-Learning-Worker/0.1",
        ...init.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractDefinitions(entry) {
  if (!entry?.meanings) {
    return [];
  }

  const definitions = [];

  for (const meaning of entry.meanings) {
    for (const item of meaning.definitions ?? []) {
      if (!item.definition) {
        continue;
      }

      definitions.push({
        partOfSpeech: meaning.partOfSpeech ?? "",
        definition: item.definition,
        example: item.example ?? "",
        source: "free_dictionary",
      });
    }
  }

  return definitions.slice(0, 10);
}

function extractPhonetics(entry) {
  if (!entry?.phonetics) {
    return [];
  }

  return entry.phonetics
    .filter((item) => item.text || item.audio)
    .map((item) => ({
      text: item.text ?? "",
      audio: item.audio ?? "",
      source: "free_dictionary",
    }))
    .slice(0, 5);
}

function splitPartsOfSpeech(rawValue) {
  if (!rawValue) {
    return [];
  }

  return String(rawValue)
    .split(/[,\s/;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateTerm(rawTerm) {
  if (typeof rawTerm !== "string") {
    return {
      ok: false,
      reason: "Term must be a string.",
    };
  }

  const term = rawTerm
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z'-]/g, "");

  if (!term) {
    return {
      ok: false,
      reason: "Term is empty after normalization.",
    };
  }

  if (term.length > 64) {
    return {
      ok: false,
      reason: "Term is too long.",
    };
  }

  if (!/^[a-z]+(?:['-][a-z]+)*$/.test(term)) {
    return {
      ok: false,
      reason: "Term must be a single English word.",
    };
  }

  return {
    ok: true,
    term,
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function settledError(source, result) {
  if (result.status === "fulfilled") {
    return null;
  }

  return {
    source,
    message: result.reason instanceof Error ? result.reason.message : "Unknown error.",
  };
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function uniqueByText(values) {
  const seen = new Set();
  const results = [];

  for (const value of values) {
    const text = value.text?.trim();
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    results.push({
      ...value,
      text,
    });
  }

  return results.slice(0, 10);
}

function getNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getGoogleTranslateMonthlyLimit(env) {
  return getNumber(env.GOOGLE_TRANSLATE_MONTHLY_LIMIT, DEFAULT_GOOGLE_TRANSLATE_MONTHLY_LIMIT);
}

function currentUsageMonth() {
  return new Date().toISOString().slice(0, 7);
}

function countCharacters(value) {
  return Array.from(value || "").length;
}

async function createTranslationCacheKey(purpose, text) {
  const normalized = `${purpose}:${String(text).trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return `${purpose}:${toHex(digest)}`;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cleanChineseMeaning(text) {
  if (!text) {
    return "";
  }

  return String(text).replace(/\s+/g, " ").trim();
}

function cleanTranslatedSentence(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isTruthy(value) {
  return value === "1" || value === "true" || value === "yes";
}
