const FREE_DICTIONARY_BASE_URL = "https://api.dictionaryapi.dev/api/v2/entries/en";
const DATAMUSE_BASE_URL = "https://api.datamuse.com/words";
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_BATCH_LIMIT = 50;
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
  const errors = [
    settledError("free_dictionary", freeDictionaryResult),
    settledError("datamuse_synonyms", synonymsResult),
    settledError("datamuse_near_synonyms", nearSynonymsResult),
  ].filter(Boolean);

  const payload = buildWordPayload({
    term,
    ecdict,
    freeDictionary,
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

function buildWordPayload({ term, ecdict, freeDictionary, synonyms, nearSynonyms, errors }) {
  const firstFreeEntry = Array.isArray(freeDictionary) ? freeDictionary[0] : null;
  const definitions = extractDefinitions(firstFreeEntry);
  const examples = definitions
    .filter((item) => item.example)
    .map((item) => ({
      text: item.example,
      source: item.source,
    }));
  const phonetics = extractPhonetics(firstFreeEntry);
  const phonetic = ecdict?.phonetic || phonetics.find((item) => item.text)?.text || "";
  const partsOfSpeech = uniqueStrings([
    ...splitPartsOfSpeech(ecdict?.pos),
    ...definitions.map((item) => item.partOfSpeech).filter(Boolean),
  ]);
  const translations = ecdict?.translation
    ? [
        {
          text: ecdict.translation,
          source: "ecdict_d1",
        },
      ]
    : [];
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
        translation: translations.length ? "ecdict_d1" : "pending",
        definition: definitions.length ? "free_dictionary" : ecdict?.definition ? "ecdict_d1" : "pending",
        synonyms: synonyms.length ? "datamuse" : "pending",
        nearSynonyms: nearSynonyms.length ? "datamuse" : "pending",
      },
    },
  };
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

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "EN-Learning-Worker/0.1",
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

function isTruthy(value) {
  return value === "1" || value === "true" || value === "yes";
}
