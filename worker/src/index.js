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
const AUTH_CODE_TTL_SECONDS = 10 * 60;
const AUTH_CODE_COOLDOWN_SECONDS = 60;
const MAX_AUTH_CODE_ATTEMPTS = 5;
const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const FIREBASE_TOKEN_ISSUER = "https://securetoken.google.com";

let firebaseJwksCache = {
  keys: [],
  expiresAt: 0,
};

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
          emailProvider: getEmailProvider(env),
          hasEmailSender: Boolean(env.EMAIL_FROM && (env.BREVO_API_KEY || env.RESEND_API_KEY || env.EMAIL_API_KEY)),
          hasFirebaseAuth: Boolean(env.FIREBASE_PROJECT_ID),
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

      if (request.method === "POST" && url.pathname === "/auth/member") {
        return jsonResponse(await handleMemberAuth(request, env));
      }

      if (request.method === "POST" && url.pathname === "/auth/firebase") {
        return jsonResponse(await handleFirebaseAuth(request, env));
      }

      if (request.method === "POST" && url.pathname === "/auth/email/request") {
        const user = await requireUser(request, env);
        return jsonResponse(await handleEmailVerificationRequest(user, env));
      }

      if (request.method === "POST" && url.pathname === "/auth/email/verify") {
        const user = await requireUser(request, env);
        return jsonResponse(await handleEmailVerificationConfirm(request, user, env));
      }

      if (request.method === "POST" && url.pathname === "/auth/password-reset/request") {
        return jsonResponse(await handlePasswordResetRequest(request, env));
      }

      if (request.method === "POST" && url.pathname === "/auth/password-reset/confirm") {
        return jsonResponse(await handlePasswordResetConfirm(request, env));
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
        ensureVerifiedUser(user);
        return jsonResponse(await handleBookList(user, env));
      }

      if (request.method === "GET" && url.pathname === "/book/contains") {
        const user = await requireUser(request, env);
        ensureVerifiedUser(user);
        const word = url.searchParams.get("word");
        return jsonResponse(await handleBookContains(user, word, env));
      }

      if (request.method === "POST" && url.pathname === "/book") {
        const user = await requireUser(request, env);
        ensureVerifiedUser(user);
        return jsonResponse(await handleBookAdd(request, user, env));
      }

      if (request.method === "POST" && url.pathname === "/book/familiarity") {
        const user = await requireUser(request, env);
        ensureVerifiedUser(user);
        return jsonResponse(await handleBookFamiliarity(request, user, env));
      }

      if (request.method === "DELETE" && url.pathname === "/book") {
        const user = await requireUser(request, env);
        ensureVerifiedUser(user);
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

  const user = await createUser(env.DB, email, password);
  const session = await createSession(env.DB, user.id);
  return {
    ok: true,
    user: publicUser(user),
    emailVerified: Boolean(user.email_verified),
    token: session.token,
    expiresAt: session.expiresAt,
    created: true,
  };
}

async function handleMemberAuth(request, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? "");
  validateEmailAndPassword(email, password);

  const existing = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.password_hash, u.password_salt, u.created_at,
              EXISTS(SELECT 1 FROM verified_emails v WHERE v.email = u.email) AS email_verified
       FROM users u
       WHERE u.email = ?
       LIMIT 1`,
    )
    .bind(email)
    .first();

  if (existing) {
    const expectedHash = await hashPassword(password, existing.password_salt);
    if (expectedHash !== existing.password_hash) {
      throw httpError(401, "invalid_credentials", "這個信箱已註冊，請確認密碼。");
    }

    const session = await createSession(env.DB, existing.id);
    return {
      ok: true,
      user: publicUser(existing),
      emailVerified: Boolean(existing.email_verified),
      token: session.token,
      expiresAt: session.expiresAt,
      created: false,
    };
  }

  const user = await createUser(env.DB, email, password);
  const session = await createSession(env.DB, user.id);
  return {
    ok: true,
    user: publicUser(user),
    emailVerified: Boolean(user.email_verified),
    token: session.token,
    expiresAt: session.expiresAt,
    created: true,
  };
}

async function handleFirebaseAuth(request, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const idToken = String(body?.idToken ?? "").trim();
  if (!idToken) {
    throw httpError(400, "missing_firebase_token", "缺少 Firebase 登入令牌。");
  }

  const firebaseUser = await verifyFirebaseIdToken(idToken, env);
  const user = await upsertFirebaseUser(env.DB, firebaseUser);
  const session = await createSession(env.DB, user.id);
  return {
    ok: true,
    user: publicUser(user),
    emailVerified: Boolean(user.email_verified),
    token: session.token,
    expiresAt: session.expiresAt,
    created: Boolean(user.created),
    firebaseUid: firebaseUser.uid,
  };
}

async function upsertFirebaseUser(db, firebaseUser) {
  const now = new Date().toISOString();
  const email = normalizeEmail(firebaseUser.email);
  if (!email) {
    throw httpError(400, "firebase_email_missing", "Firebase 會員缺少信箱資料。");
  }

  let localUser = await db
    .prepare(
      `SELECT u.id, u.email, u.created_at,
              EXISTS(SELECT 1 FROM verified_emails v WHERE v.email = u.email) AS email_verified
       FROM firebase_users f
       JOIN users u ON u.id = f.user_id
       WHERE f.firebase_uid = ?
       LIMIT 1`,
    )
    .bind(firebaseUser.uid)
    .first();

  let created = false;
  if (!localUser) {
    localUser = await db
      .prepare(
        `SELECT u.id, u.email, u.created_at,
                EXISTS(SELECT 1 FROM verified_emails v WHERE v.email = u.email) AS email_verified
         FROM users u
         WHERE u.email = ?
         LIMIT 1`,
      )
      .bind(email)
      .first();
  }

  if (!localUser) {
    localUser = await createUser(db, email, randomHex(32));
    created = true;
  }

  await db
    .prepare(
      `INSERT INTO firebase_users
         (firebase_uid, user_id, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(firebase_uid) DO UPDATE SET
         user_id = excluded.user_id,
         email = excluded.email,
         email_verified = excluded.email_verified,
         updated_at = excluded.updated_at`,
    )
    .bind(
      firebaseUser.uid,
      localUser.id,
      email,
      firebaseUser.emailVerified ? 1 : 0,
      now,
      now,
    )
    .run();

  if (firebaseUser.emailVerified) {
    await markEmailVerified(db, email, localUser.id);
    localUser.email_verified = 1;
  }

  return {
    ...localUser,
    email,
    created,
    email_verified: Boolean(localUser.email_verified),
  };
}

async function createUser(db, email, password) {
  const now = new Date().toISOString();
  const user = {
    id: randomHex(16),
    email,
    created_at: now,
    email_verified: 0,
  };
  const passwordSalt = randomHex(16);
  const passwordHash = await hashPassword(password, passwordSalt);

  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(user.id, user.email, passwordHash, passwordSalt, now)
    .run();

  return user;
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
      `SELECT u.id, u.email, u.password_hash, u.password_salt, u.created_at,
              EXISTS(SELECT 1 FROM verified_emails v WHERE v.email = u.email) AS email_verified
       FROM users u
       WHERE u.email = ?
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
    emailVerified: Boolean(user.email_verified),
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

async function handleEmailVerificationRequest(user, env) {
  ensureDatabase(env);
  if (await isEmailVerified(env.DB, user.email)) {
    return {
      ok: true,
      sent: false,
      email: user.email,
      emailVerified: true,
      message: "這個信箱已完成驗證。",
    };
  }

  await createAndSendAuthCode(env, user.email, "email_verification");
  return {
    ok: true,
    sent: true,
    email: user.email,
    emailVerified: false,
    expiresInSeconds: AUTH_CODE_TTL_SECONDS,
  };
}

async function handleEmailVerificationConfirm(request, user, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const code = normalizeAuthCode(body?.code);
  await consumeAuthCode(env.DB, env, user.email, "email_verification", code);
  await markEmailVerified(env.DB, user.email, user.id);
  return {
    ok: true,
    email: user.email,
    emailVerified: true,
  };
}

async function handlePasswordResetRequest(request, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, "invalid_email", "請輸入有效的信箱。");
  }

  const user = await env.DB
    .prepare(`SELECT id, email FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first();

  if (user) {
    await createAndSendAuthCode(env, email, "password_reset");
  }

  return {
    ok: true,
    sent: true,
    message: "如果信箱已註冊，驗證碼已寄出。",
  };
}

async function handlePasswordResetConfirm(request, env) {
  ensureDatabase(env);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = normalizeAuthCode(body?.code);
  const password = String(body?.password ?? "");
  validateEmailAndPassword(email, password);

  const user = await env.DB
    .prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first();
  if (!user) {
    throw invalidAuthCodeError();
  }

  await consumeAuthCode(env.DB, env, email, "password_reset", code);

  const passwordSalt = randomHex(16);
  const passwordHash = await hashPassword(password, passwordSalt);
  await env.DB
    .prepare(
      `UPDATE users
       SET password_hash = ?, password_salt = ?
       WHERE id = ?`,
    )
    .bind(passwordHash, passwordSalt, user.id)
    .run();

  await env.DB
    .prepare(`DELETE FROM auth_sessions WHERE user_id = ?`)
    .bind(user.id)
    .run();

  return {
    ok: true,
    message: "密碼已更新，請使用新密碼登入。",
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
      `SELECT s.user_id, u.id, u.email, u.created_at,
              EXISTS(SELECT 1 FROM verified_emails v WHERE v.email = u.email) AS email_verified
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
    email_verified: session.email_verified,
  };
}

function ensureVerifiedUser(user) {
  if (!user?.email_verified) {
    throw httpError(403, "email_not_verified", "請先完成信箱驗證。");
  }
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

async function createAndSendAuthCode(env, email, purpose) {
  ensureAuthCodeSecret(env);
  ensureEmailConfig(env);

  const normalizedEmail = normalizeEmail(email);
  const normalizedPurpose = String(purpose ?? "").trim();
  if (!["email_verification", "password_reset"].includes(normalizedPurpose)) {
    throw httpError(400, "invalid_purpose", "不支援的驗證碼用途。");
  }

  const now = new Date();
  const recent = await env.DB
    .prepare(
      `SELECT created_at
       FROM auth_email_codes
       WHERE email = ? AND purpose = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(normalizedEmail, normalizedPurpose)
    .first();
  if (recent?.created_at) {
    const elapsedMs = now.getTime() - new Date(recent.created_at).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs < AUTH_CODE_COOLDOWN_SECONDS * 1000) {
      throw httpError(429, "too_many_requests", "驗證碼剛寄出，請稍等一下再重試。");
    }
  }

  const code = randomNumericCode(6);
  const codeSalt = randomHex(16);
  const codeHash = await hashAuthCode(code, codeSalt, env);
  const id = randomHex(16);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();

  await env.DB
    .prepare(
      `INSERT INTO auth_email_codes
         (id, email, purpose, code_hash, code_salt, attempts, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, normalizedEmail, normalizedPurpose, codeHash, codeSalt, createdAt, expiresAt)
    .run();

  try {
    await sendAuthEmail(env, {
      to: normalizedEmail,
      purpose: normalizedPurpose,
      code,
    });
  } catch (error) {
    await env.DB
      .prepare(`DELETE FROM auth_email_codes WHERE id = ?`)
      .bind(id)
      .run();
    throw error;
  }
}

async function consumeAuthCode(db, env, email, purpose, code) {
  ensureAuthCodeSecret(env);
  const normalizedCode = normalizeAuthCode(code);
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw invalidAuthCodeError();
  }

  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT id, code_hash, code_salt, attempts
       FROM auth_email_codes
       WHERE email = ?
         AND purpose = ?
         AND consumed_at IS NULL
         AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(normalizeEmail(email), purpose, now)
    .first();

  if (!row || row.attempts >= MAX_AUTH_CODE_ATTEMPTS) {
    throw invalidAuthCodeError();
  }

  const expectedHash = await hashAuthCode(normalizedCode, row.code_salt, env);
  if (expectedHash !== row.code_hash) {
    await db
      .prepare(`UPDATE auth_email_codes SET attempts = attempts + 1 WHERE id = ?`)
      .bind(row.id)
      .run();
    throw invalidAuthCodeError();
  }

  await db
    .prepare(`UPDATE auth_email_codes SET consumed_at = ? WHERE id = ?`)
    .bind(now, row.id)
    .run();
}

async function isEmailVerified(db, email) {
  const row = await db
    .prepare(`SELECT email FROM verified_emails WHERE email = ? LIMIT 1`)
    .bind(normalizeEmail(email))
    .first();
  return Boolean(row);
}

async function markEmailVerified(db, email, userId) {
  await db
    .prepare(
      `INSERT INTO verified_emails (email, user_id, verified_at)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         user_id = excluded.user_id,
         verified_at = excluded.verified_at`,
    )
    .bind(normalizeEmail(email), userId, new Date().toISOString())
    .run();
}

async function hashAuthCode(code, salt, env) {
  return await sha256Hex(`${env.AUTH_CODE_SECRET}:${salt}:${normalizeAuthCode(code)}`);
}

function normalizeAuthCode(value) {
  return String(value ?? "").replace(/\D+/g, "").slice(0, 6);
}

async function verifyFirebaseIdToken(idToken, env) {
  const projectId = String(env.FIREBASE_PROJECT_ID ?? "").trim();
  if (!projectId) {
    throw httpError(503, "firebase_not_configured", "尚未設定 Firebase Project ID。");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw httpError(401, "invalid_firebase_token", "Firebase 登入令牌格式不正確。");
  }

  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) {
    throw httpError(401, "invalid_firebase_token", "Firebase 登入令牌標頭不正確。");
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) {
    throw httpError(401, "firebase_token_expired", "Firebase 登入狀態已過期，請重新登入。");
  }
  if (!payload.iat || payload.iat > now + 60) {
    throw httpError(401, "invalid_firebase_token", "Firebase 登入令牌時間不正確。");
  }
  if (payload.aud !== projectId) {
    throw httpError(401, "invalid_firebase_token", "Firebase 專案不符合目前後端設定。");
  }
  if (payload.iss !== `${FIREBASE_TOKEN_ISSUER}/${projectId}`) {
    throw httpError(401, "invalid_firebase_token", "Firebase 登入令牌發行者不正確。");
  }
  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length > 128) {
    throw httpError(401, "invalid_firebase_token", "Firebase 會員識別不正確。");
  }

  const key = await readFirebasePublicKey(header.kid);
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) {
    throw httpError(401, "invalid_firebase_token", "Firebase 登入令牌簽章驗證失敗。");
  }

  return {
    uid: payload.sub,
    email: normalizeEmail(payload.email),
    emailVerified: payload.email_verified === true,
  };
}

async function readFirebasePublicKey(kid) {
  const now = Date.now();
  if (!firebaseJwksCache.keys.length || firebaseJwksCache.expiresAt <= now) {
    const response = await fetchWithTimeout(FIREBASE_JWKS_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "EN-Learning-Worker/0.1",
      },
    });
    if (!response.ok) {
      throw httpError(503, "firebase_keys_unavailable", "目前無法取得 Firebase 公開金鑰。");
    }

    const cacheControl = response.headers.get("Cache-Control") ?? "";
    const maxAge = Number.parseInt(cacheControl.match(/max-age=(\d+)/)?.[1] ?? "3600", 10);
    const body = await response.json();
    firebaseJwksCache = {
      keys: Array.isArray(body.keys) ? body.keys : [],
      expiresAt: now + Math.max(60, maxAge) * 1000,
    };
  }

  const jwk = firebaseJwksCache.keys.find((item) => item.kid === kid);
  if (!jwk) {
    firebaseJwksCache = { keys: [], expiresAt: 0 };
    throw httpError(401, "firebase_key_not_found", "找不到 Firebase 登入令牌對應的公開金鑰。");
  }

  return await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      kid: jwk.kid,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
    },
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );
}

function parseJwtPart(part) {
  try {
    return JSON.parse(base64UrlToString(part));
  } catch {
    throw httpError(401, "invalid_firebase_token", "Firebase 登入令牌內容無法解析。");
  }
}

function base64UrlToString(value) {
  return atob(toBase64(value));
}

function base64UrlToBytes(value) {
  const binary = atob(toBase64(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBase64(value) {
  const text = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return text.padEnd(text.length + (4 - (text.length % 4 || 4)), "=");
}

async function sendAuthEmail(env, { to, purpose, code }) {
  const provider = getEmailProvider(env);
  const fromEmail = String(env.EMAIL_FROM ?? "").trim();
  const fromName = String(env.EMAIL_FROM_NAME ?? "Alpaca English").trim() || "Alpaca English";
  const message = buildAuthEmailMessage(purpose, code);

  if (provider === "resend") {
    await sendResendEmail(env, {
      to,
      fromEmail,
      fromName,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return;
  }

  if (provider === "brevo") {
    await sendBrevoEmail(env, {
      to,
      fromEmail,
      fromName,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return;
  }

  throw httpError(503, "email_provider_unsupported", "目前只支援 Brevo 或 Resend 免費寄信供應商。");
}

async function sendBrevoEmail(env, message) {
  const apiKey = getEmailApiKey(env, "brevo");
  const response = await fetchWithTimeout(
    "https://api.brevo.com/v3/smtp/email",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "api-key": apiKey,
        "User-Agent": "EN-Learning-Worker/0.1",
      },
      body: JSON.stringify({
        sender: {
          name: message.fromName,
          email: message.fromEmail,
        },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
      }),
    },
  );
  await ensureEmailProviderOk(response, "Brevo");
}

async function sendResendEmail(env, message) {
  const apiKey = getEmailApiKey(env, "resend");
  const response = await fetchWithTimeout(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "EN-Learning-Worker/0.1",
      },
      body: JSON.stringify({
        from: `${message.fromName} <${message.fromEmail}>`,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    },
  );
  await ensureEmailProviderOk(response, "Resend");
}

async function ensureEmailProviderOk(response, providerName) {
  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw httpError(
    502,
    "email_provider_error",
    `${providerName} 寄信失敗：HTTP ${response.status}。${compactProviderError(body)}`,
  );
}

function buildAuthEmailMessage(purpose, code) {
  const isReset = purpose === "password_reset";
  const title = isReset ? "重設密碼驗證碼" : "信箱驗證碼";
  const subject = `Alpaca English ${title}`;
  const action = isReset ? "重設密碼" : "完成信箱驗證";
  const text = [
    `你的 Alpaca English ${title}是：${code}`,
    `請在 ${Math.round(AUTH_CODE_TTL_SECONDS / 60)} 分鐘內輸入，用來${action}。`,
    "如果不是你本人操作，可以直接忽略這封信。",
  ].join("\n");
  const escapedCode = escapeHtml(code);
  const escapedAction = escapeHtml(action);
  const html = [
    "<div style=\"font-family:Arial,'Noto Sans TC',sans-serif;line-height:1.6;color:#253247\">",
    "<h2 style=\"margin:0 0 12px\">Alpaca English</h2>",
    `<p>你的${escapeHtml(title)}是：</p>`,
    `<p style=\"font-size:28px;font-weight:700;letter-spacing:6px;color:#2EA9B5\">${escapedCode}</p>`,
    `<p>請在 ${Math.round(AUTH_CODE_TTL_SECONDS / 60)} 分鐘內輸入，用來${escapedAction}。</p>`,
    "<p style=\"color:#667085\">如果不是你本人操作，可以直接忽略這封信。</p>",
    "</div>",
  ].join("");

  return { subject, text, html };
}

function getEmailProvider(env) {
  return String(env.EMAIL_PROVIDER ?? "brevo").trim().toLowerCase();
}

function getEmailApiKey(env, provider) {
  const value = provider === "resend"
    ? env.RESEND_API_KEY || env.EMAIL_API_KEY
    : env.BREVO_API_KEY || env.EMAIL_API_KEY;
  const apiKey = String(value ?? "").trim();
  if (!apiKey) {
    throw httpError(
      503,
      "email_not_configured",
      provider === "resend"
        ? "尚未設定 Resend 金鑰。請在 Cloudflare Worker 設定 RESEND_API_KEY。"
        : "尚未設定 Brevo 金鑰。請在 Cloudflare Worker 設定 BREVO_API_KEY。",
    );
  }
  return apiKey;
}

function ensureEmailConfig(env) {
  const provider = getEmailProvider(env);
  if (!["brevo", "resend"].includes(provider)) {
    throw httpError(503, "email_provider_unsupported", "目前只支援 Brevo 或 Resend 免費寄信供應商。");
  }

  const fromEmail = String(env.EMAIL_FROM ?? "").trim();
  if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
    throw httpError(503, "email_not_configured", "尚未設定有效的寄件信箱 EMAIL_FROM。");
  }

  getEmailApiKey(env, provider);
}

function ensureAuthCodeSecret(env) {
  if (!String(env.AUTH_CODE_SECRET ?? "").trim()) {
    throw httpError(503, "auth_code_secret_missing", "尚未設定驗證碼安全密鑰 AUTH_CODE_SECRET。");
  }
}

function invalidAuthCodeError() {
  return httpError(400, "invalid_code", "驗證碼不正確或已過期，請重新取得。");
}

function randomNumericCode(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => String(byte % 10)).join("");
}

function compactProviderError(body) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 180) : "請檢查寄信服務金鑰與寄件信箱。";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    emailVerified: Boolean(user.email_verified),
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
    const cached = await readCachedWordPayload(env.DB, term, env);
    if (cached) {
      return {
        ...cached.payload,
        ok: true,
        fromCache: true,
        cacheStatus: cached.aliasTerm ? "alias" : "fresh",
        requestedTerm: term,
        canonicalTerm: cached.canonicalTerm,
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

  let payload = buildWordPayload({
    term,
    ecdict,
    freeDictionary,
    definitions,
    googleTranslation,
    exampleTranslations,
    errors,
  });

  const canonicalTerm = canonicalTermFromPayload(payload, term);
  if (canonicalTerm !== term) {
    payload = normalizePayloadForCanonicalTerm(payload, canonicalTerm);
    await writeWordAlias(env.DB, term, canonicalTerm, "canonical_word");
  }

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

async function readCachedWordPayload(db, term, env) {
  if (!db) {
    return null;
  }

  const alias = await readWordAlias(db, term);
  if (alias?.canonical_term) {
    const canonicalTerm = canonicalTermFromRaw(alias.canonical_term, term);
    if (canonicalTerm !== term) {
      const aliasedPayload = await readWordCache(db, canonicalTerm);
      if (aliasedPayload) {
        return {
          payload: aliasedPayload,
          aliasTerm: term,
          canonicalTerm,
        };
      }
    }
  }

  const inferred = await readCachedCanonicalCandidate(db, term);
  if (inferred) {
    await writeWordAlias(db, term, inferred.canonicalTerm, "derived_cache");
    return {
      payload: inferred.payload,
      aliasTerm: term,
      canonicalTerm: inferred.canonicalTerm,
    };
  }

  const exactPayload = await readWordCache(db, term);
  if (!exactPayload) {
    return null;
  }

  const canonicalTerm = canonicalTermFromPayload(exactPayload, term);
  if (canonicalTerm !== term) {
    await writeWordAlias(db, term, canonicalTerm, "cached_payload");
    const canonicalPayload = normalizePayloadForCanonicalTerm(exactPayload, canonicalTerm);
    await writeWordCache(db, canonicalPayload, env);
    return {
      payload: canonicalPayload,
      aliasTerm: term,
      canonicalTerm,
    };
  }

  return {
    payload: exactPayload,
    aliasTerm: "",
    canonicalTerm,
  };
}

async function readCachedCanonicalCandidate(db, term) {
  for (const candidate of canonicalCandidatesForTerm(term)) {
    if (candidate === term) {
      continue;
    }

    const payload = await readWordCache(db, candidate);
    if (payload) {
      return {
        payload,
        canonicalTerm: candidate,
      };
    }
  }

  return null;
}

async function readWordAlias(db, aliasTerm) {
  if (!db) {
    return null;
  }

  return await db
    .prepare(
      `SELECT canonical_term, source, updated_at
       FROM word_aliases
       WHERE alias_term = ?
       LIMIT 1`,
    )
    .bind(aliasTerm)
    .first();
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

async function writeWordAlias(db, aliasTerm, canonicalTerm, source) {
  if (!db) {
    return;
  }

  const alias = canonicalTermFromRaw(aliasTerm, "");
  const canonical = canonicalTermFromRaw(canonicalTerm, "");
  if (!alias || !canonical || alias === canonical) {
    return;
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO word_aliases (alias_term, canonical_term, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alias_term) DO UPDATE SET
         canonical_term = excluded.canonical_term,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .bind(alias, canonical, cleanSmallText(source, "runtime"), now, now)
    .run();
}

function canonicalTermFromPayload(payload, fallbackTerm) {
  return canonicalTermFromRaw(
    payload?.entry?.canonicalWord
      || payload?.entry?.word
      || payload?.normalizedTerm
      || payload?.term,
    fallbackTerm,
  );
}

function canonicalTermFromRaw(rawTerm, fallbackTerm) {
  const validation = validateTerm(rawTerm);
  if (validation.ok) {
    return validation.term;
  }

  const fallback = validateTerm(fallbackTerm);
  return fallback.ok ? fallback.term : "";
}

function normalizePayloadForCanonicalTerm(payload, canonicalTerm) {
  if (!payload || !canonicalTerm) {
    return payload;
  }

  return {
    ...payload,
    term: canonicalTerm,
    normalizedTerm: canonicalTerm,
    entry: {
      ...(payload.entry ?? {}),
      word: canonicalTerm,
      canonicalWord: canonicalTerm,
    },
  };
}

function canonicalCandidatesForTerm(term) {
  const validation = validateTerm(term);
  if (!validation.ok) {
    return [];
  }

  const normalized = validation.term;
  const parts = normalized.split(" ");
  if (parts.length > 1) {
    const phrase = parts
      .map((part) => canonicalCandidatesForToken(part)[0] ?? part)
      .join(" ");
    return uniqueStrings([phrase]);
  }

  return canonicalCandidatesForToken(normalized);
}

function canonicalCandidatesForToken(token) {
  const candidates = [];
  if (!/^[a-z]+(?:['-][a-z]+)?$/.test(token) || token.length <= 3) {
    return candidates;
  }

  if (token.endsWith("ies") && token.length > 4) {
    candidates.push(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("ves") && token.length > 4) {
    candidates.push(`${token.slice(0, -3)}f`);
  }
  if (token.endsWith("ied") && token.length > 4) {
    candidates.push(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("ing") && token.length > 5) {
    const stem = token.slice(0, -3);
    candidates.push(stem);
    candidates.push(removeDoubledEnding(stem));
    candidates.push(`${stem}e`);
  }
  if (token.endsWith("ed") && token.length > 4) {
    const stem = token.slice(0, -2);
    candidates.push(stem);
    candidates.push(removeDoubledEnding(stem));
    candidates.push(`${stem}e`);
  }
  if (token.endsWith("es") && token.length > 4) {
    candidates.push(token.slice(0, -2));
  }
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) {
    candidates.push(token.slice(0, -1));
  }

  return uniqueStrings(candidates.filter((candidate) => validateTerm(candidate).ok));
}

function removeDoubledEnding(value) {
  if (!value || value.length < 3) {
    return value;
  }

  const last = value.length - 1;
  return value[last] === value[last - 1] ? value.slice(0, last) : value;
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
