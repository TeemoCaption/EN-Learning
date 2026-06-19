package com.teemocaption.enlearning.data;

import com.teemocaption.enlearning.net.WordApiClient;
import com.teemocaption.enlearning.util.WordNormalizer;

import java.util.List;

public class WordRepository {
    private final AppDatabase database;
    private final WordApiClient lookupService;

    public WordRepository(AppDatabase database, WordApiClient lookupService) {
        this.database = database;
        this.lookupService = lookupService;
    }

    public synchronized WordEntry lookupNetworkFirst(String rawWord) {
        List<String> candidates = WordNormalizer.lookupCandidates(rawWord);
        if (candidates.isEmpty()) return createPending(rawWord, "請輸入英文單字");
        String word = candidates.get(0);

        Exception lastError = null;
        for (String candidate : candidates) {
            try {
                WordEntry entry = lookupService.lookup(candidate);
                entry.word = WordNormalizer.normalizeQuery(entry.word);
                if (entry.word.isEmpty()) entry.word = candidate;
                entry.originalWord = word;
                entry.fromCache = false;
                database.addRecentSearch(entry.word);
                return entry;
            } catch (Exception networkError) {
                lastError = networkError;
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
        // 收藏已改由雲端會員單字本管理，這裡保留方法避免舊呼叫點誤寫本機收藏。
    }

    public ImportWordStatus enrichImportedWord(String rawWord, String sourceName) {
        String word = WordNormalizer.normalizeQuery(rawWord);
        if (word.isEmpty()) return ImportWordStatus.FAILED;
        try {
            WordEntry entry = lookupNetworkFirst(rawWord);
            if (entry.partial) {
                database.addPendingWord(entry.word, "部分欄位尚未補齊");
                return ImportWordStatus.PARTIAL;
            }
            return ImportWordStatus.SUCCESS;
        } catch (Exception error) {
            createPending(word, error.getMessage());
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
        database.addPendingWord(word, reason == null ? "待補資料" : reason);
        return pending;
    }

    public enum ImportWordStatus {
        SUCCESS,
        PARTIAL,
        FAILED
    }
}
