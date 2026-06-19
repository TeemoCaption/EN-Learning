package com.teemocaption.enlearning.net;

import com.teemocaption.enlearning.BuildConfig;
import com.teemocaption.enlearning.data.AuthSession;
import com.teemocaption.enlearning.data.WordEntry;

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
import java.util.ArrayList;
import java.util.List;

public class WordApiClient {
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;
    private static final String GOOGLE_TRANSLATE_SOURCE = "google_cloud_translation";

    public WordEntry lookup(String word) throws IOException, JSONException {
        String baseUrl = configuredBaseUrl();
        if (!baseUrl.isEmpty()) {
            return lookupFromBackend(baseUrl, word);
        }
        return lookupFromPublicApis(word);
    }

    public AuthSession register(String email, String password) throws IOException, JSONException {
        return authenticate("auth/register", email, password);
    }

    public AuthSession login(String email, String password) throws IOException, JSONException {
        return authenticate("auth/login", email, password);
    }

    public AuthSession authenticateMember(String email, String password) throws IOException, JSONException {
        return authenticate("auth/member", email, password);
    }

    public AuthSession authenticateFirebase(String firebaseIdToken) throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("idToken", firebaseIdToken);
        JSONObject object = new JSONObject(request("POST", backendUrl("auth/firebase"), body.toString(), null));
        if (!object.optBoolean("ok", false)) throwBackendError(object);
        JSONObject user = object.optJSONObject("user");
        AuthSession session = new AuthSession();
        session.token = object.optString("token", "");
        session.email = user == null ? "" : user.optString("email", "");
        session.expiresAt = object.optString("expiresAt", "");
        session.created = object.optBoolean("created", false);
        session.emailVerified = object.optBoolean("emailVerified",
                user != null && user.optBoolean("emailVerified", false));
        session.firebaseUid = object.optString("firebaseUid", "");
        if (session.token.trim().isEmpty()) throw new IOException("Backend did not return an auth token.");
        return session;
    }

    public List<WordEntry> getBook(String token) throws IOException, JSONException {
        JSONObject object = new JSONObject(request("GET", backendUrl("book"), null, token));
        if (!object.optBoolean("ok", false)) throwBackendError(object);
        JSONArray entries = object.optJSONArray("entries");
        List<WordEntry> words = new ArrayList<>();
        if (entries == null) return words;
        for (int i = 0; i < entries.length(); i++) {
            JSONObject item = entries.optJSONObject(i);
            if (item == null) continue;
            WordEntry entry = readUnifiedWord(item, item.optString("word", ""));
            entry.favorite = item.optBoolean("favorite", true);
            entry.familiarity = item.optInt("familiarity", 0);
            words.add(entry);
        }
        return words;
    }

    public boolean isBookWord(String token, String word) throws IOException, JSONException {
        JSONObject object = new JSONObject(request("GET",
                backendUrl("book/contains?word=" + encode(word)), null, token));
        if (!object.optBoolean("ok", false)) throwBackendError(object);
        return object.optBoolean("favorite", false);
    }

    public WordEntry addBookWord(String token, String word, String sourceType, String sourceName)
            throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("word", word);
        body.put("sourceType", sourceType);
        body.put("sourceName", sourceName);
        JSONObject object = new JSONObject(request("POST", backendUrl("book"), body.toString(), token));
        if (!object.optBoolean("ok", false)) throwBackendError(object);
        JSONObject item = object.optJSONObject("item");
        if (item == null) throw new IOException("Backend did not return a book item.");
        WordEntry entry = readUnifiedWord(item, word);
        entry.favorite = item.optBoolean("favorite", true);
        entry.familiarity = item.optInt("familiarity", 0);
        return entry;
    }

    public void removeBookWord(String token, String word) throws IOException, JSONException {
        JSONObject object = new JSONObject(request("DELETE",
                backendUrl("book?word=" + encode(word)), null, token));
        if (!object.optBoolean("ok", false)) throwBackendError(object);
    }

    private AuthSession authenticate(String path, String email, String password)
            throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("password", password);
        JSONObject object = new JSONObject(request("POST", backendUrl(path), body.toString(), null));
        if (!object.optBoolean("ok", false)) throwBackendError(object);
        JSONObject user = object.optJSONObject("user");
        AuthSession session = new AuthSession();
        session.token = object.optString("token", "");
        session.email = user == null ? email : user.optString("email", email);
        session.expiresAt = object.optString("expiresAt", "");
        session.created = object.optBoolean("created", false);
        session.emailVerified = object.optBoolean("emailVerified",
                user != null && user.optBoolean("emailVerified", false));
        if (session.token.trim().isEmpty()) throw new IOException("Backend did not return an auth token.");
        return session;
    }

    private WordEntry lookupFromBackend(String baseUrl, String word) throws IOException, JSONException {
        String separator = baseUrl.endsWith("/") ? "" : "/";
        String json = get(baseUrl + separator + "word?term=" + encode(word));
        JSONObject object = new JSONObject(json);
        if (!object.optBoolean("ok", true)) {
            throw new IOException(object.optString("message", "Backend lookup failed."));
        }
        WordEntry entry = readUnifiedWord(object, word);
        entry.source = "後端字典服務";
        return entry;
    }

    private WordEntry lookupFromPublicApis(String word) throws IOException, JSONException {
        WordEntry entry = new WordEntry(word);
        entry.source = "Free Dictionary";

        boolean dictionaryOk = false;
        try {
            String json = get("https://api.dictionaryapi.dev/api/v2/entries/en/" + encode(word));
            parseFreeDictionary(entry, json);
            dictionaryOk = true;
        } catch (IOException | JSONException ignored) {
            dictionaryOk = false;
        }

        entry.partial = !dictionaryOk
                || isBlank(entry.chineseMeaning)
                || isBlank(entry.phonetic)
                || isBlank(entry.englishDefinition);
        if (!dictionaryOk && !entry.hasDisplayableData()) {
            throw new IOException("No remote word data");
        }
        return entry;
    }

    private void parseFreeDictionary(WordEntry entry, String json) throws JSONException {
        JSONArray array = new JSONArray(json);
        if (array.length() == 0) return;
        JSONObject first = array.getJSONObject(0);
        entry.word = first.optString("word", entry.word);

        JSONArray phonetics = first.optJSONArray("phonetics");
        if (phonetics != null) {
            for (int i = 0; i < phonetics.length(); i++) {
                JSONObject phonetic = phonetics.optJSONObject(i);
                if (phonetic == null) continue;
                String text = phonetic.optString("text", "");
                if (!text.trim().isEmpty()) {
                    entry.phonetic = text;
                    break;
                }
            }
        }

        List<String> parts = new ArrayList<>();
        List<String> definitions = new ArrayList<>();
        List<String> examples = new ArrayList<>();
        JSONArray meanings = first.optJSONArray("meanings");
        if (meanings != null) {
            for (int i = 0; i < meanings.length(); i++) {
                JSONObject meaning = meanings.optJSONObject(i);
                if (meaning == null) continue;
                String part = meaning.optString("partOfSpeech", "");
                if (!part.isEmpty() && !parts.contains(part)) parts.add(part);

                JSONArray defs = meaning.optJSONArray("definitions");
                if (defs == null) continue;
                for (int j = 0; j < defs.length(); j++) {
                    JSONObject def = defs.optJSONObject(j);
                    if (def == null) continue;
                    String definition = def.optString("definition", "");
                    if (!definition.isEmpty() && definitions.size() < 3) definitions.add(definition);
                    String example = def.optString("example", "");
                    if (!example.isEmpty() && examples.size() < 3) examples.add(example);
                }
            }
        }

        entry.partOfSpeech = join(parts);
        entry.englishDefinition = join(definitions);
        entry.examples = WordEntry.cleanList(examples, 3);
    }

    private static String shortenChineseMeaning(String text) {
        if (text == null) return "";
        return text
                .replace("&#39;", "'")
                .replace("&quot;", "\"")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private WordEntry readUnifiedWord(JSONObject object, String fallbackWord) {
        JSONObject backendEntry = object.optJSONObject("entry");
        if (backendEntry != null) {
            return readBackendEntry(object, backendEntry, fallbackWord);
        }

        WordEntry entry = new WordEntry(object.optString("word", fallbackWord));
        entry.originalWord = object.optString("originalWord", entry.word);
        entry.chineseMeaning = object.optString("chineseMeaning", "");
        entry.phonetic = object.optString("phonetic", "");
        entry.partOfSpeech = object.optString("partOfSpeech", "");
        entry.englishDefinition = object.optString("englishDefinition", "");
        entry.examples = readStringArray(object, "examples", 3);
        entry.exampleTranslations = readStringArray(object, "exampleTranslations", 3);
        entry.partial = object.optBoolean("partial", false);
        return entry;
    }

    private WordEntry readBackendEntry(JSONObject response, JSONObject object, String fallbackWord) {
        WordEntry entry = new WordEntry(object.optString("word",
                object.optString("canonicalWord", fallbackWord)));
        entry.originalWord = response.optString("term", entry.word);
        entry.chineseMeaning = shortenChineseMeaning(readFirstObjectText(object, "translations", "text"));
        entry.phonetic = object.optString("phonetic", "");
        entry.partOfSpeech = join(readStringArray(object, "partsOfSpeech", 4));
        entry.englishDefinition = join(readObjectTextArray(object, "definitions", "definition", 3));
        readBackendExamples(object, entry);
        if (isGoogleRelatedWordsSource(object, "synonyms")) {
            entry.synonyms = readStringArray(object, "synonyms", 10);
        }
        if (isGoogleRelatedWordsSource(object, "nearSynonyms")) {
            entry.relatedWords = readStringArray(object, "nearSynonyms", 10);
        }
        entry.partial = isBackendPending(response);
        return entry;
    }

    private boolean isGoogleRelatedWordsSource(JSONObject object, String key) {
        JSONObject source = object.optJSONObject("source");
        if (source == null) return false;
        String value = source.optString(key, "");
        return GOOGLE_TRANSLATE_SOURCE.equals(value) || (GOOGLE_TRANSLATE_SOURCE + "_cache").equals(value);
    }

    private void readBackendExamples(JSONObject object, WordEntry entry) {
        JSONArray array = object.optJSONArray("examples");
        if (array == null) {
            entry.examples = readStringArray(object, "examples", 3);
            return;
        }

        List<String> examples = new ArrayList<>();
        List<String> translations = new ArrayList<>();
        for (int i = 0; i < array.length() && examples.size() < 3; i++) {
            Object value = array.opt(i);
            if (value instanceof JSONObject) {
                JSONObject item = (JSONObject) value;
                String text = item.optString("text", "").trim();
                if (!text.isEmpty()) {
                    examples.add(text);
                    String translation = item.optString("translation", "").trim();
                    if (!translation.isEmpty()) translations.add(translation);
                }
            } else {
                String text = array.optString(i, "").trim();
                if (!text.isEmpty()) examples.add(text);
            }
        }
        entry.examples = WordEntry.cleanList(examples, 3);
        entry.exampleTranslations = WordEntry.cleanList(translations, 3);
    }

    private boolean isBackendPending(JSONObject response) {
        String status = response.optString("status", "");
        if ("pending".equals(status)) return true;
        JSONArray missing = response.optJSONArray("missing");
        if (missing == null) return false;
        for (int i = 0; i < missing.length(); i++) {
            String value = missing.optString(i, "");
            if ("translation".equals(value) || "phonetic".equals(value) || "definition".equals(value)) {
                return true;
            }
        }
        return false;
    }

    private String readFirstObjectText(JSONObject object, String key, String textKey) {
        List<String> values = readObjectTextArray(object, key, textKey, 1);
        return values.isEmpty() ? "" : values.get(0);
    }

    private List<String> readObjectTextArray(JSONObject object, String key, String textKey, int maxItems) {
        List<String> values = new ArrayList<>();
        JSONArray array = object.optJSONArray(key);
        if (array == null) return values;
        for (int i = 0; i < array.length() && values.size() < maxItems; i++) {
            Object raw = array.opt(i);
            if (raw instanceof JSONObject) {
                String value = ((JSONObject) raw).optString(textKey, "").trim();
                if (!value.isEmpty()) values.add(value);
            } else {
                String value = array.optString(i, "").trim();
                if (!value.isEmpty()) values.add(value);
            }
        }
        return values;
    }

    private List<String> readStringArray(JSONObject object, String key, int maxItems) {
        List<String> values = new ArrayList<>();
        JSONArray array = object.optJSONArray(key);
        if (array != null) {
            for (int i = 0; i < array.length() && values.size() < maxItems; i++) {
                Object raw = array.opt(i);
                String value;
                if (raw instanceof JSONObject) {
                    value = ((JSONObject) raw).optString("text", "");
                } else {
                    value = array.optString(i, "");
                }
                if (!value.trim().isEmpty()) values.add(value.trim());
            }
            return values;
        }
        String text = object.optString(key, "");
        if (!text.trim().isEmpty()) values.add(text.trim());
        return values;
    }

    private static String configuredBaseUrl() {
        return BuildConfig.WORD_API_BASE_URL == null ? "" : BuildConfig.WORD_API_BASE_URL.trim();
    }

    private static String backendUrl(String path) throws IOException {
        String baseUrl = configuredBaseUrl();
        if (baseUrl.isEmpty()) throw new IOException("尚未設定後端服務網址。");
        String separator = baseUrl.endsWith("/") ? "" : "/";
        return baseUrl + separator + path;
    }

    private static String get(String url) throws IOException {
        return request("GET", url, null, null);
    }

    private static String request(String method, String url, String body, String token) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null && !token.trim().isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token.trim());
        }
        if (body != null) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
        String responseBody = readStream(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) throw new IOException(readBackendErrorMessage(responseBody, code));
        return responseBody;
    }

    private static String readBackendErrorMessage(String responseBody, int code) {
        if (responseBody != null && !responseBody.trim().isEmpty()) {
            try {
                JSONObject object = new JSONObject(responseBody);
                JSONObject error = object.optJSONObject("error");
                String message = error == null ? object.optString("message", "")
                        : error.optString("message", "");
                if (!message.trim().isEmpty()) return message.trim();
            } catch (JSONException ignored) {
                // Fall through to a compact HTTP message below.
            }
        }
        return "後端服務回覆 HTTP " + code + "，請稍後再試。";
    }

    private static void throwBackendError(JSONObject object) throws IOException {
        JSONObject error = object.optJSONObject("error");
        String message = error == null ? object.optString("message", "Backend request failed.")
                : error.optString("message", "Backend request failed.");
        throw new IOException(message);
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

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (Exception ignored) {
            return value;
        }
    }

    private static String join(List<String> values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (value == null || value.trim().isEmpty()) continue;
            if (builder.length() > 0) builder.append("; ");
            builder.append(value.trim());
        }
        return builder.toString();
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }
}
