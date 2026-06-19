package com.teemocaption.enlearning.net;

import com.teemocaption.enlearning.BuildConfig;
import com.teemocaption.enlearning.data.WordEntry;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class WordApiClient {
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 12000;

    public WordEntry lookup(String word) throws IOException, JSONException {
        String baseUrl = BuildConfig.WORD_API_BASE_URL == null ? "" : BuildConfig.WORD_API_BASE_URL.trim();
        if (!baseUrl.isEmpty()) {
            return lookupFromBackend(baseUrl, word);
        }
        return lookupFromPublicApis(word);
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
        entry.source = "Free Dictionary / Datamuse";

        boolean dictionaryOk = false;
        try {
            String json = get("https://api.dictionaryapi.dev/api/v2/entries/en/" + encode(word));
            parseFreeDictionary(entry, json);
            dictionaryOk = true;
        } catch (IOException | JSONException ignored) {
            dictionaryOk = false;
        }

        try {
            entry.synonyms = WordEntry.cleanList(readDatamuse("rel_syn", word), 10);
        } catch (IOException | JSONException ignored) {
            entry.synonyms = WordEntry.cleanList(entry.synonyms, 10);
        }

        try {
            entry.relatedWords = WordEntry.cleanList(readDatamuse("ml", word), 10);
        } catch (IOException | JSONException ignored) {
            entry.relatedWords = WordEntry.cleanList(entry.relatedWords, 10);
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
        List<String> synonyms = new ArrayList<>();
        JSONArray meanings = first.optJSONArray("meanings");
        if (meanings != null) {
            for (int i = 0; i < meanings.length(); i++) {
                JSONObject meaning = meanings.optJSONObject(i);
                if (meaning == null) continue;
                String part = meaning.optString("partOfSpeech", "");
                if (!part.isEmpty() && !parts.contains(part)) parts.add(part);

                JSONArray meaningSynonyms = meaning.optJSONArray("synonyms");
                addStrings(synonyms, meaningSynonyms, 10);

                JSONArray defs = meaning.optJSONArray("definitions");
                if (defs == null) continue;
                for (int j = 0; j < defs.length(); j++) {
                    JSONObject def = defs.optJSONObject(j);
                    if (def == null) continue;
                    String definition = def.optString("definition", "");
                    if (!definition.isEmpty() && definitions.size() < 3) definitions.add(definition);
                    String example = def.optString("example", "");
                    if (!example.isEmpty() && examples.size() < 3) examples.add(example);
                    addStrings(synonyms, def.optJSONArray("synonyms"), 10);
                }
            }
        }

        entry.partOfSpeech = join(parts);
        entry.englishDefinition = join(definitions);
        entry.examples = WordEntry.cleanList(examples, 3);
        if (entry.synonyms.isEmpty()) entry.synonyms = WordEntry.cleanList(synonyms, 10);
    }

    private List<String> readDatamuse(String relation, String word) throws IOException, JSONException {
        String json = get("https://api.datamuse.com/words?" + relation + "=" + encode(word) + "&max=10");
        JSONArray array = new JSONArray(json);
        List<String> values = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject object = array.optJSONObject(i);
            if (object == null) continue;
            String value = object.optString("word", "");
            if (!value.isEmpty()) values.add(value);
        }
        return values;
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
        entry.synonyms = readStringArray(object, "synonyms", 10);
        entry.relatedWords = readStringArray(object, "relatedWords", 10);
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
        entry.synonyms = readStringArray(object, "synonyms", 10);
        entry.relatedWords = readStringArray(object, "nearSynonyms", 10);
        entry.partial = isBackendPending(response);
        return entry;
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

    private static void addStrings(List<String> out, JSONArray array, int maxItems) {
        if (array == null) return;
        for (int i = 0; i < array.length() && out.size() < maxItems; i++) {
            String value = array.optString(i, "");
            if (!value.isEmpty() && !out.contains(value)) out.add(value);
        }
    }

    private static String get(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
        String body = readStream(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code + ": " + body);
        return body;
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
