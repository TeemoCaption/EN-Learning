const FREE_DICTIONARY_BASE_URL = "https://api.dictionaryapi.dev/api/v2/entries/en";
const GOOGLE_TRANSLATE_BASE_URL = "https://translation.googleapis.com/language/translate/v2";
const GOOGLE_TRANSLATE_SOURCE = "google_cloud_translation";
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_GOOGLE_TRANSLATE_MONTHLY_LIMIT = 450000;
const DEFAULT_EXAMPLE_TRANSLATION_LIMIT = 3;
const REQUEST_TIMEOUT_MS = 7000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_HASH_ITERATIONS = 100000;

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
          googleTranslateExampleLimit: getExampleTranslationLimit(env),
        });
      }

      if (request.method === "GET" && url.pathname === "/translation-usage") {
        const usage = await readCurrentTranslationUsage(env.DB, env);
        return jsonResponse({
          ok: true,
          usage,
        });
      }

      if (request.method === "POST" && url.pathname === "/auth/register") {
        return jsonResponse(await handleRegister(request, env));
      }

      if (request.method === "POST" && url.pathname === "/auth/login") {
        return jsonResponse(await handleLogin(request, env));
      }

      if (request.method === "GET" && url.pathname === "/auth/me") {
        const user = await requireUser(request, env);
        return jsonResponse({
          ok: true,
          user: publicUser(user),
        });
      }

      if (request.method === "GET" && url.pathname === "/book") {
        const user = await requireUser(request, env);
        return jsonResponse(await handleBookList(user, env));
      }

      if (request.method === "GET" && url.pathname === "/book/contains") {
        const user = await requireUser(request, env);
        const word = url.searchParams.get("word");
        return jsonResponse(await handleBookContains(user, word, env));
      }

      if (request.method === "POST" && url.pathname === "/book") {
        const user = await requireUser(request, env);
        return jsonResponse(await handleBookAdd(request, user, env));
      }

      if (request.method === "POST" && url.pathname === "/book/familiarity") {
        const user = await requireUser(request, env);
        return jsonResponse(await handleBookFamiliarity(request, user, env));
      }

      if (request.method === "DELETE" && url.pathname === "/book") {
        const user = await requireUser(request, env);
        const word = url.searchParams.get("word");
        return jsonResponse(await handleBookRemove(user, word, env));
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
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return jsonResponse(
        {
          ok: false,
          error: {
            code: error?.code ?? "internal_error",
            message: error instanceof Error ? error.message : "Unknown error.",
          },
        },
        status,
      );
    }
  },
};

async function handleRegister(request, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? "");
  validateEmailAndPassword(email, password);

  const existing = await env.DB
    .prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first();
  if (existing) {
    throw httpError(409, "email_exists", "這個信箱已經註冊。");
  }

  const now = new Date().toISOString();
  const user = {
    id: randomHex(16),
    email,
    created_at: now,
  };
  const passwordSalt = randomHex(16);
  const passwordHash = await hashPassword(password, passwordSalt);

  await env.DB
    .prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(user.id, user.email, passwordHash, passwordSalt, now)
    .run();

  const session = await createSession(env.DB, user.id);
  return {
    ok: true,
    user: publicUser(user),
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

async function handleLogin(request, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? "");
  if (!email || !password) {
    throw httpError(400, "invalid_credentials", "請輸入信箱與密碼。");
  }

  const user = await env.DB
    .prepare(
      `SELECT id, email, password_hash, password_salt, created_at
       FROM users
       WHERE email = ?
       LIMIT 1`,
    )
    .bind(email)
    .first();
  if (!user) {
    throw httpError(401, "invalid_credentials", "信箱或密碼不正確。");
  }

  const expectedHash = await hashPassword(password, user.password_salt);
  if (expectedHash !== user.password_hash) {
    throw httpError(401, "invalid_credentials", "信箱或密碼不正確。");
  }

  const session = await createSession(env.DB, user.id);
  return {
    ok: true,
    user: publicUser(user),
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

async function handleBookList(user, env) {
  const rows = await env.DB
    .prepare(
      `SELECT word, familiarity, favorite, source_type, source_name, added_at, review_count
       FROM cloud_user_words
       WHERE user_id = ? AND favorite = 1
       ORDER BY added_at DESC`,
    )
    .bind(user.id)
    .all();

  const entries = [];
  for (const row of rows.results ?? []) {
    entries.push(await buildBookItem(row, env));
  }

  return {
    ok: true,
    user: publicUser(user),
    entries,
  };
}

async function handleBookContains(user, rawWord, env) {
  const validation = validateTerm(rawWord);
  if (!validation.ok) {
    return {
      ok: true,
      word: rawWord ?? "",
      favorite: false,
    };
  }
  const row = await readCloudUserWord(env.DB, user.id, validation.term);
  return {
    ok: true,
    word: validation.term,
    favorite: Boolean(row?.favorite),
    familiarity: row?.familiarity ?? 0,
  };
}

async function handleBookAdd(request, user, env) {
  const body = await readJson(request);
  const validation = validateTerm(body?.word);
  if (!validation.ok) {
    throw httpError(400, "invalid_word", validation.reason);
  }

  const payload = await lookupWord(validation.term, env);
  const word = validateTerm(payload?.entry?.word).ok
    ? validateTerm(payload.entry.word).term
    : validation.term;
  const now = new Date().toISOString();
  const sourceType = cleanSmallText(body?.sourceType, "manual");
  const sourceName = cleanSmallText(body?.sourceName, "");
  const existing = await readCloudUserWord(env.DB, user.id, word);

  await env.DB
    .prepare(
      `INSERT INTO cloud_user_words
         (user_id, word, familiarity, favorite, source_type, source_name, added_at, review_count)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(user_id, word) DO UPDATE SET
         favorite = 1,
         source_type = excluded.source_type,
         source_name = excluded.source_name,
         added_at = COALESCE(cloud_user_words.added_at, excluded.added_at),
         familiarity = cloud_user_words.familiarity,
         review_count = cloud_user_words.review_count`,
    )
    .bind(
      user.id,
      word,
      existing?.familiarity ?? 0,
      sourceType,
      sourceName,
      existing?.added_at ?? now,
      existing?.review_count ?? 0,
    )
    .run();

  const row = await readCloudUserWord(env.DB, user.id, word);
  return {
    ok: true,
    item: await buildBookItem(row, env, payload),
  };
}

async function handleBookFamiliarity(request, user, env) {
  const body = await readJson(request);
  const validation = validateTerm(body?.word);
  if (!validation.ok) {
    throw httpError(400, "invalid_word", validation.reason);
  }
  const familiarity = Math.max(0, Math.min(5, Number.parseInt(body?.familiarity ?? "0", 10) || 0));
  const row = await readCloudUserWord(env.DB, user.id, validation.term);
  if (!row) {
    throw httpError(404, "not_in_book", "這個單字尚未加入收藏。");
  }

  await env.DB
    .prepare(
      `UPDATE cloud_user_words
       SET familiarity = ?
       WHERE user_id = ? AND word = ?`,
    )
    .bind(familiarity, user.id, validation.term)
    .run();

  return {
    ok: true,
    word: validation.term,
    familiarity,
  };
}

async function handleBookRemove(user, rawWord, env) {
  const validation = validateTerm(rawWord);
  if (!validation.ok) {
    throw httpError(400, "invalid_word", validation.reason);
  }

  await env.DB
    .prepare(`DELETE FROM cloud_user_words WHERE user_id = ? AND word = ?`)
    .bind(user.id, validation.term)
    .run();

  return {
    ok: true,
    word: validation.term,
    favorite: false,
  };
}

async function buildBookItem(row, env, existingPayload = null) {
  const payload = existingPayload ?? await lookupWord(row.word, env);
  return {
    ...payload,
    favorite: Boolean(row.favorite),
    familiarity: row.familiarity ?? 0,
    sourceType: row.source_type ?? "",
    sourceName: row.source_name ?? "",
    addedAt: row.added_at ?? "",
  };
}

async function readCloudUserWord(db, userId, word) {
  return await db
    .prepare(
      `SELECT word, familiarity, favorite, source_type, source_name, added_at, review_count
       FROM cloud_user_words
       WHERE user_id = ? AND word = ?
       LIMIT 1`,
    )
    .bind(userId, word)
    .first();
}

async function requireUser(request, env) {
  ensureDatabase(env);
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw httpError(401, "missing_token", "請先登入會員。");
  }

  const tokenHash = await sha256Hex(match[1].trim());
  const now = new Date().toISOString();
  const session = await env.DB
    .prepare(
      `SELECT s.user_id, u.id, u.email, u.created_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first();
  if (!session) {
    throw httpError(401, "invalid_token", "登入狀態已失效，請重新登入。");
  }

  return {
    id: session.id,
    email: session.email,
    created_at: session.created_at,
  };
}

async function createSession(db, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(tokenHash, userId, now.toISOString(), expiresAt)
    .run();
  return { token, expiresAt };
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: PASSWORD_HASH_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return toHex(bits);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return toHex(digest);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function validateEmailAndPassword(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, "invalid_email", "請輸入有效的信箱。");
  }
  if (password.length < 8 || password.length > 72) {
    throw httpError(400, "invalid_password", "密碼長度需為 8 到 72 個字元。");
  }
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.created_at,
  };
}

function cleanSmallText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 120) : fallback;
}

function ensureDatabase(env) {
  if (!env.DB) {
    throw httpError(503, "database_unavailable", "雲端資料庫尚未設定。");
  }
}

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

  const [ecdictResult, freeDictionaryResult] =
    await Promise.allSettled([
      readEcdictWord(env.DB, term),
      fetchFreeDictionary(term),
    ]);

  const ecdict = settledValue(ecdictResult);
  const freeDictionary = settledValue(freeDictionaryResult);
  const firstFreeEntry = Array.isArray(freeDictionary) ? freeDictionary[0] : null;
  const definitions = extractDefinitions(firstFreeEntry);
  const errors = [
    settledError("free_dictionary", freeDictionaryResult),
  ].filter(Boolean);

  let googleTranslation = null;
  const translationResult = await tryTranslateTextWithGoogle(term, env, "word");
  if (translationResult.ok) {
    googleTranslation = translationResult.translation;
  } else if (translationResult.error) {
    errors.push(translationResult.error);
  }

  const exampleTranslations = await translateDictionaryExamplesWithGoogle(definitions, env, errors);

  const payload = buildWordPayload({
    term,
    ecdict,
    freeDictionary,
    definitions,
    googleTranslation,
    exampleTranslations,
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

async function translateDictionaryExamplesWithGoogle(definitions, env, errors) {
  const exampleTranslations = new Map();
  const examples = uniqueStrings(definitions.map((item) => item.example).filter(Boolean))
    .slice(0, getExampleTranslationLimit(env));

  for (const example of examples) {
    const exampleTranslationResult = await tryTranslateTextWithGoogle(example, env, "example");
    if (exampleTranslationResult.ok) {
      exampleTranslations.set(example, exampleTranslationResult.translation);
    } else if (exampleTranslationResult.error) {
      errors.push(exampleTranslationResult.error);
    }
  }

  return exampleTranslations;
}

function buildWordPayload({
  term,
  ecdict,
  freeDictionary,
  definitions,
  googleTranslation,
  exampleTranslations,
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
      synonyms: [],
      nearSynonyms: [],
      source: {
        translation: translations.length ? translations[0].source : "pending",
        definition: definitions.length ? "free_dictionary" : ecdict?.definition ? "ecdict_d1" : "pending",
        synonyms: "not_supported",
        nearSynonyms: "not_supported",
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
    return stripUnsupportedRelatedWords(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
}

function stripUnsupportedRelatedWords(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (payload.entry && typeof payload.entry === "object") {
    payload.entry.synonyms = [];
    payload.entry.nearSynonyms = [];
    payload.entry.source = {
      ...(payload.entry.source ?? {}),
      synonyms: "not_supported",
      nearSynonyms: "not_supported",
    };
  }

  if (Array.isArray(payload.missing)) {
    payload.missing = payload.missing.filter((item) => item !== "synonyms" && item !== "nearSynonyms");
    if (payload.status === "partial" && payload.missing.length === 0) {
      payload.status = "complete";
    }
  }

  return payload;
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
    .replace(/[^a-z'\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

  if (!/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){0,3}$/.test(term)) {
    return {
      ok: false,
      reason: "Term must be an English word or short phrase.",
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

function getExampleTranslationLimit(env) {
  const parsed = Number.parseInt(env?.GOOGLE_TRANSLATE_EXAMPLE_LIMIT ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_EXAMPLE_TRANSLATION_LIMIT;
  }

  return Math.min(parsed, 10);
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

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
