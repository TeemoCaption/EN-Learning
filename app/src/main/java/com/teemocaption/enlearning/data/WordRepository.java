package com.teemocaption.enlearning.data;

import com.teemocaption.enlearning.net.WordApiClient;
import com.teemocaption.enlearning.util.WordNormalizer;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class WordRepository {
    private final AppDatabase database;
    private final WordApiClient lookupService;
    private final Map<String, WordEntry> inMemoryResults = new HashMap<>();

    public WordRepository(AppDatabase database, WordApiClient lookupService) {
        this.database = database;
        this.lookupService = lookupService;
    }

    public synchronized WordEntry lookupNetworkFirst(String rawWord) {
        List<String> candidates = WordNormalizer.lookupCandidates(rawWord);
        if (candidates.isEmpty()) return createPending(rawWord, "請輸入英文單字");
        String word = candidates.get(0);
        if (inMemoryResults.containsKey(word)) {
            WordEntry cached = inMemoryResults.get(word);
            cached.fromCache = true;
            return cached;
        }

        Exception lastError = null;
        for (String candidate : candidates) {
            try {
                WordEntry entry = lookupService.lookup(candidate);
                entry.word = WordNormalizer.normalizeQuery(entry.word);
                if (entry.word.isEmpty()) entry.word = candidate;
                entry.originalWord = word;
                entry.fromCache = false;
                database.upsertWord(entry);
                database.addRecentSearch(entry.word);
                database.removePendingWord(entry.word);
                inMemoryResults.put(word, entry);
                return entry;
            } catch (Exception networkError) {
                lastError = networkError;
            }
        }

        for (String candidate : candidates) {
            WordEntry cached = database.getWord(candidate);
            if (cached != null && cached.hasDisplayableData()) {
                cached.fromCache = true;
                database.addRecentSearch(candidate);
                return cached;
            }
        }

        String reason = lastError == null || lastError.getMessage() == null
                ? "目前查不到網路資料，已加入待補清單。"
                : lastError.getMessage();
        return createPending(word, reason);
    }

    public synchronized WordEntry lookup(String rawWord) {
        return lookupNetworkFirst(rawWord);
    }

    public void addToBook(WordEntry entry, String sourceType, String sourceName) {
        if (entry == null) return;
        addToBook(entry.word, sourceType, sourceName);
    }

    public void addToBook(String word, String sourceType, String sourceName) {
        String normalized = WordNormalizer.normalizeQuery(word);
        if (!normalized.isEmpty()) {
            database.addUserWord(normalized, sourceType, sourceName);
        }
    }

    public ImportWordStatus enrichImportedWord(String rawWord, String sourceName) {
        String word = WordNormalizer.normalizeQuery(rawWord);
        if (word.isEmpty()) return ImportWordStatus.FAILED;
        try {
            WordEntry entry = lookupNetworkFirst(rawWord);
            addToBook(entry.word, "import", sourceName);
            if (entry.partial) {
                database.addPendingWord(entry.word, "部分欄位尚未補齊");
                return ImportWordStatus.PARTIAL;
            }
            return ImportWordStatus.SUCCESS;
        } catch (Exception error) {
            WordEntry pending = createPending(word, error.getMessage());
            database.upsertWord(pending);
            database.addUserWord(word, "import", sourceName);
            return ImportWordStatus.FAILED;
        }
    }

    public AppDatabase database() {
        return database;
    }

    private WordEntry createPending(String rawWord, String reason) {
        List<String> candidates = WordNormalizer.lookupCandidates(rawWord);
        String word = candidates.isEmpty() ? WordNormalizer.normalizeQuery(rawWord) : candidates.get(0);
        if (word.isEmpty()) word = rawWord == null ? "" : rawWord.trim().toLowerCase();
        WordEntry pending = new WordEntry(word);
        pending.chineseMeaning = "待補資料";
        pending.source = "待補清單";
        pending.partial = true;
        pending.fromCache = true;
        database.upsertWord(pending);
        database.addPendingWord(word, reason == null ? "待補資料" : reason);
        return pending;
    }

    public enum ImportWordStatus {
        SUCCESS,
        PARTIAL,
        FAILED
    }
}
