package com.teemocaption.enlearning.net;

import com.teemocaption.enlearning.BuildConfig;
import com.teemocaption.enlearning.data.AuthSession;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class FirebaseAuthClient {
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;
    private static final String IDENTITY_BASE_URL = "https://identitytoolkit.googleapis.com/v1/";
    private static final String SECURE_TOKEN_BASE_URL = "https://securetoken.googleapis.com/v1/";

    public AuthSession authenticate(String email, String password) throws IOException, JSONException {
        try {
            return readAccount(signIn(email, password));
        } catch (FirebaseAuthException error) {
            if (!"EMAIL_NOT_FOUND".equals(error.code)
                    && !"INVALID_LOGIN_CREDENTIALS".equals(error.code)) {
                throw error;
            }
            AuthSession session = readAccount(signUp(email, password));
            sendEmailVerification(session.firebaseIdToken);
            return session;
        }
    }

    public AuthSession refresh(String refreshToken) throws IOException, JSONException {
        ensureConfigured();
        JSONObject body = new JSONObject();
        body.put("grant_type", "refresh_token");
        body.put("refresh_token", refreshToken);
        JSONObject object = post("token", body, true);

        AuthSession session = new AuthSession();
        session.firebaseIdToken = object.optString("id_token", "");
        session.firebaseRefreshToken = object.optString("refresh_token", refreshToken);
        session.firebaseUid = object.optString("user_id", "");
        if (session.firebaseIdToken.trim().isEmpty()) {
            throw new IOException("Firebase 未回傳登入令牌，請重新登入。");
        }
        AuthSession account = lookup(session.firebaseIdToken);
        session.email = account.email;
        session.emailVerified = account.emailVerified;
        if (session.firebaseUid.trim().isEmpty()) session.firebaseUid = account.firebaseUid;
        return session;
    }

    public AuthSession lookup(String idToken) throws IOException, JSONException {
        ensureConfigured();
        JSONObject body = new JSONObject();
        body.put("idToken", idToken);
        JSONObject object = post("accounts:lookup", body, false);
        JSONArray users = object.optJSONArray("users");
        JSONObject user = users == null || users.length() == 0 ? null : users.optJSONObject(0);
        if (user == null) {
            throw new IOException("Firebase 找不到目前登入會員，請重新登入。");
        }

        AuthSession session = new AuthSession();
        session.firebaseIdToken = idToken;
        session.firebaseUid = user.optString("localId", "");
        session.email = user.optString("email", "");
        session.emailVerified = user.optBoolean("emailVerified", false);
        return session;
    }

    public void sendEmailVerification(String idToken) throws IOException, JSONException {
        ensureConfigured();
        JSONObject body = new JSONObject();
        body.put("requestType", "VERIFY_EMAIL");
        body.put("idToken", idToken);
        post("accounts:sendOobCode", body, false);
    }

    public void sendPasswordResetEmail(String email) throws IOException, JSONException {
        ensureConfigured();
        JSONObject body = new JSONObject();
        body.put("requestType", "PASSWORD_RESET");
        body.put("email", email);
        try {
            post("accounts:sendOobCode", body, false);
        } catch (FirebaseAuthException error) {
            if (!"EMAIL_NOT_FOUND".equals(error.code)) {
                throw error;
            }
        }
    }

    private JSONObject signIn(String email, String password) throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("password", password);
        body.put("returnSecureToken", true);
        return post("accounts:signInWithPassword", body, false);
    }

    private JSONObject signUp(String email, String password) throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("password", password);
        body.put("returnSecureToken", true);
        return post("accounts:signUp", body, false);
    }

    private AuthSession readAccount(JSONObject object) throws IOException, JSONException {
        AuthSession session = new AuthSession();
        session.firebaseIdToken = object.optString("idToken", "");
        session.firebaseRefreshToken = object.optString("refreshToken", "");
        session.firebaseUid = object.optString("localId", "");
        session.email = object.optString("email", "");
        if (session.firebaseIdToken.trim().isEmpty()) {
            throw new IOException("Firebase 未回傳登入令牌，請重新登入。");
        }

        AuthSession account = lookup(session.firebaseIdToken);
        session.emailVerified = account.emailVerified;
        if (session.email.trim().isEmpty()) session.email = account.email;
        if (session.firebaseUid.trim().isEmpty()) session.firebaseUid = account.firebaseUid;
        return session;
    }

    private JSONObject post(String path, JSONObject body, boolean secureToken)
            throws IOException, JSONException {
        String baseUrl = secureToken ? SECURE_TOKEN_BASE_URL : IDENTITY_BASE_URL;
        String url = baseUrl + path + "?key=" + encode(apiKey());
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("X-Firebase-Locale", "zh-TW");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
        }

        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
        String responseBody = readStream(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) {
            throw readFirebaseError(responseBody, code);
        }
        return new JSONObject(responseBody);
    }

    private static FirebaseAuthException readFirebaseError(String responseBody, int code) {
        String firebaseCode = "";
        if (responseBody != null && !responseBody.trim().isEmpty()) {
            try {
                JSONObject object = new JSONObject(responseBody);
                JSONObject error = object.optJSONObject("error");
                firebaseCode = error == null ? "" : error.optString("message", "");
            } catch (JSONException ignored) {
                firebaseCode = "";
            }
        }
        return new FirebaseAuthException(firebaseCode, readableFirebaseError(firebaseCode, code));
    }

    private static String readableFirebaseError(String firebaseCode, int httpCode) {
        if ("EMAIL_EXISTS".equals(firebaseCode)) return "這個信箱已註冊，請確認密碼。";
        if ("EMAIL_NOT_FOUND".equals(firebaseCode)) return "這個信箱尚未註冊。";
        if ("INVALID_PASSWORD".equals(firebaseCode)
                || "INVALID_LOGIN_CREDENTIALS".equals(firebaseCode)) {
            return "信箱或密碼不正確。";
        }
        if ("INVALID_EMAIL".equals(firebaseCode)) return "請輸入有效的信箱。";
        if ("WEAK_PASSWORD : Password should be at least 6 characters".equals(firebaseCode)) {
            return "密碼至少需要 6 個字元。";
        }
        if ("USER_DISABLED".equals(firebaseCode)) return "這個會員帳號已停用。";
        if ("OPERATION_NOT_ALLOWED".equals(firebaseCode)) {
            return "Firebase 尚未啟用信箱密碼登入，請到 Firebase Authentication 開啟。";
        }
        if ("TOO_MANY_ATTEMPTS_TRY_LATER".equals(firebaseCode)) {
            return "嘗試次數過多，請稍後再試。";
        }
        if ("TOKEN_EXPIRED".equals(firebaseCode) || "INVALID_ID_TOKEN".equals(firebaseCode)) {
            return "登入狀態已過期，請重新登入。";
        }
        return "Firebase 回覆 HTTP " + httpCode + "，請稍後再試。";
    }

    private static String readStream(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static void ensureConfigured() throws IOException {
        if (apiKey().trim().isEmpty()) {
            throw new IOException("尚未設定 Firebase Web API Key，請用 FIREBASE_WEB_API_KEY 建置 APP。");
        }
    }

    private static String apiKey() {
        return BuildConfig.FIREBASE_WEB_API_KEY == null ? "" : BuildConfig.FIREBASE_WEB_API_KEY.trim();
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (Exception ignored) {
            return value;
        }
    }

    private static class FirebaseAuthException extends IOException {
        final String code;

        FirebaseAuthException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
