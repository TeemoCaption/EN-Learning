package com.teemocaption.enlearning.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

public class AppDatabase extends SQLiteOpenHelper {
    private static final String DB_NAME = "en_learning.db";
    private static final int DB_VERSION = 2;

    public AppDatabase(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE word_entries (" +
                "word TEXT PRIMARY KEY, " +
                "original_word TEXT, " +
                "chinese_meaning TEXT, " +
                "phonetic TEXT, " +
                "part_of_speech TEXT, " +
                "english_definition TEXT, " +
                "examples TEXT, " +
                "example_translations TEXT, " +
                "synonyms TEXT, " +
                "related_words TEXT, " +
                "source TEXT, " +
                "updated_at INTEGER, " +
                "partial INTEGER DEFAULT 0)");

        db.execSQL("CREATE TABLE user_words (" +
                "word TEXT PRIMARY KEY, " +
                "familiarity INTEGER DEFAULT 0, " +
                "favorite INTEGER DEFAULT 1, " +
                "source_type TEXT, " +
                "source_name TEXT, " +
                "added_at INTEGER, " +
                "review_count INTEGER DEFAULT 0)");

        db.execSQL("CREATE TABLE pending_words (" +
                "word TEXT PRIMARY KEY, " +
                "reason TEXT, " +
                "retry_count INTEGER DEFAULT 0, " +
                "last_retry_at INTEGER)");

        db.execSQL("CREATE TABLE import_batches (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "file_name TEXT, " +
                "format TEXT, " +
                "imported_at INTEGER, " +
                "total_extracted INTEGER, " +
                "unique_count INTEGER, " +
                "success_count INTEGER, " +
                "partial_count INTEGER, " +
                "failed_count INTEGER)");

        db.execSQL("CREATE TABLE recent_searches (" +
                "word TEXT PRIMARY KEY, " +
                "searched_at INTEGER)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE word_entries ADD COLUMN example_translations TEXT DEFAULT ''");
            return;
        }
        db.execSQL("DROP TABLE IF EXISTS word_entries");
        db.execSQL("DROP TABLE IF EXISTS user_words");
        db.execSQL("DROP TABLE IF EXISTS pending_words");
        db.execSQL("DROP TABLE IF EXISTS import_batches");
        db.execSQL("DROP TABLE IF EXISTS recent_searches");
        onCreate(db);
    }

    public synchronized void upsertWord(WordEntry entry) {
        WordEntry existing = getWord(entry.word);
        if (existing != null) {
            entry = merge(existing, entry);
        }
        ContentValues values = new ContentValues();
        values.put("word", entry.word);
        values.put("original_word", entry.originalWord);
        values.put("chinese_meaning", entry.chineseMeaning);
        values.put("phonetic", entry.phonetic);
        values.put("part_of_speech", entry.partOfSpeech);
        values.put("english_definition", entry.englishDefinition);
        values.put("examples", joinLines(entry.examples));
        values.put("example_translations", joinLines(entry.exampleTranslations));
        values.put("synonyms", joinLines(entry.synonyms));
        values.put("related_words", joinLines(entry.relatedWords));
        values.put("source", entry.source);
        values.put("updated_at", entry.updatedAt);
        values.put("partial", entry.partial ? 1 : 0);
        getWritableDatabase().insertWithOnConflict(
                "word_entries", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized WordEntry getWord(String word) {
        try (Cursor cursor = getReadableDatabase().query(
                "word_entries",
                null,
                "word = ?",
                new String[]{word},
                null,
                null,
                null)) {
            if (!cursor.moveToFirst()) return null;
            return readWord(cursor, true);
        }
    }

    public synchronized List<WordEntry> getWordsForBook() {
        String sql = "SELECT w.* FROM word_entries w " +
                "JOIN user_words u ON u.word = w.word " +
                "ORDER BY u.added_at DESC";
        List<WordEntry> entries = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, null)) {
            while (cursor.moveToNext()) entries.add(readWord(cursor, true));
        }
        return entries;
    }

    public synchronized void addUserWord(String word, String sourceType, String sourceName) {
        UserWord existing = getUserWord(word);
        ContentValues values = new ContentValues();
        values.put("word", word);
        values.put("favorite", 1);
        values.put("source_type", sourceType);
        values.put("source_name", appendSource(existing == null ? null : existing.sourceName, sourceName));
        values.put("added_at", existing == null ? System.currentTimeMillis() : existing.addedAt);
        values.put("familiarity", existing == null ? 0 : existing.familiarity);
        values.put("review_count", existing == null ? 0 : existing.reviewCount);
        getWritableDatabase().insertWithOnConflict(
                "user_words", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized void removeUserWord(String word) {
        getWritableDatabase().delete("user_words", "word = ?", new String[]{word});
    }

    public synchronized void updateFamiliarity(String word, int familiarity) {
        ContentValues values = new ContentValues();
        values.put("familiarity", Math.max(0, Math.min(5, familiarity)));
        getWritableDatabase().update("user_words", values, "word = ?", new String[]{word});
    }

    public synchronized UserWord getUserWord(String word) {
        try (Cursor cursor = getReadableDatabase().query(
                "user_words",
                null,
                "word = ?",
                new String[]{word},
                null,
                null,
                null)) {
            if (!cursor.moveToFirst()) return null;
            UserWord userWord = new UserWord();
            userWord.word = cursor.getString(cursor.getColumnIndexOrThrow("word"));
            userWord.familiarity = cursor.getInt(cursor.getColumnIndexOrThrow("familiarity"));
            userWord.favorite = cursor.getInt(cursor.getColumnIndexOrThrow("favorite")) == 1;
            userWord.sourceType = cursor.getString(cursor.getColumnIndexOrThrow("source_type"));
            userWord.sourceName = cursor.getString(cursor.getColumnIndexOrThrow("source_name"));
            userWord.addedAt = cursor.getLong(cursor.getColumnIndexOrThrow("added_at"));
            userWord.reviewCount = cursor.getInt(cursor.getColumnIndexOrThrow("review_count"));
            return userWord;
        }
    }

    public synchronized void addPendingWord(String word, String reason) {
        SQLiteDatabase db = getWritableDatabase();
        int retryCount = 0;
        try (Cursor cursor = db.query(
                "pending_words",
                new String[]{"retry_count"},
                "word = ?",
                new String[]{word},
                null,
                null,
                null)) {
            if (cursor.moveToFirst()) retryCount = cursor.getInt(0) + 1;
        }
        ContentValues values = new ContentValues();
        values.put("word", word);
        values.put("reason", reason);
        values.put("retry_count", retryCount);
        values.put("last_retry_at", System.currentTimeMillis());
        db.insertWithOnConflict("pending_words", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized void removePendingWord(String word) {
        getWritableDatabase().delete("pending_words", "word = ?", new String[]{word});
    }

    public synchronized List<String> getPendingWords() {
        List<String> words = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
                "pending_words",
                new String[]{"word"},
                null,
                null,
                null,
                null,
                "last_retry_at DESC")) {
            while (cursor.moveToNext()) words.add(cursor.getString(0));
        }
        return words;
    }

    public synchronized void addRecentSearch(String word) {
        ContentValues values = new ContentValues();
        values.put("word", word);
        values.put("searched_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict(
                "recent_searches", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized List<String> getRecentSearches(int limit) {
        List<String> words = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
                "recent_searches",
                new String[]{"word"},
                null,
                null,
                null,
                null,
                "searched_at DESC",
                String.valueOf(limit))) {
            while (cursor.moveToNext()) words.add(cursor.getString(0));
        }
        return words;
    }

    public synchronized long insertImportBatch(String fileName, String format, int total, int unique) {
        ContentValues values = new ContentValues();
        values.put("file_name", fileName);
        values.put("format", format);
        values.put("imported_at", System.currentTimeMillis());
        values.put("total_extracted", total);
        values.put("unique_count", unique);
        values.put("success_count", 0);
        values.put("partial_count", 0);
        values.put("failed_count", 0);
        return getWritableDatabase().insert("import_batches", null, values);
    }

    public synchronized void updateImportBatch(long id, int success, int partial, int failed) {
        ContentValues values = new ContentValues();
        values.put("success_count", success);
        values.put("partial_count", partial);
        values.put("failed_count", failed);
        getWritableDatabase().update("import_batches", values, "id = ?", new String[]{String.valueOf(id)});
    }

    private WordEntry readWord(Cursor cursor, boolean fromCache) {
        WordEntry entry = new WordEntry(cursor.getString(cursor.getColumnIndexOrThrow("word")));
        entry.originalWord = cursor.getString(cursor.getColumnIndexOrThrow("original_word"));
        entry.chineseMeaning = cursor.getString(cursor.getColumnIndexOrThrow("chinese_meaning"));
        entry.phonetic = cursor.getString(cursor.getColumnIndexOrThrow("phonetic"));
        entry.partOfSpeech = cursor.getString(cursor.getColumnIndexOrThrow("part_of_speech"));
        entry.englishDefinition = cursor.getString(cursor.getColumnIndexOrThrow("english_definition"));
        entry.examples = splitLines(cursor.getString(cursor.getColumnIndexOrThrow("examples")));
        entry.exampleTranslations = splitLines(cursor.getString(cursor.getColumnIndexOrThrow("example_translations")));
        entry.synonyms = splitLines(cursor.getString(cursor.getColumnIndexOrThrow("synonyms")));
        entry.relatedWords = splitLines(cursor.getString(cursor.getColumnIndexOrThrow("related_words")));
        entry.source = cursor.getString(cursor.getColumnIndexOrThrow("source"));
        entry.updatedAt = cursor.getLong(cursor.getColumnIndexOrThrow("updated_at"));
        entry.partial = cursor.getInt(cursor.getColumnIndexOrThrow("partial")) == 1;
        entry.fromCache = fromCache;
        return entry;
    }

    private WordEntry merge(WordEntry oldEntry, WordEntry newEntry) {
        WordEntry merged = new WordEntry(firstNonBlank(newEntry.word, oldEntry.word));
        merged.originalWord = firstNonBlank(newEntry.originalWord, oldEntry.originalWord);
        merged.chineseMeaning = firstNonBlank(newEntry.chineseMeaning, oldEntry.chineseMeaning);
        merged.phonetic = firstNonBlank(newEntry.phonetic, oldEntry.phonetic);
        merged.partOfSpeech = firstNonBlank(newEntry.partOfSpeech, oldEntry.partOfSpeech);
        merged.englishDefinition = firstNonBlank(newEntry.englishDefinition, oldEntry.englishDefinition);
        merged.examples = mergeLists(oldEntry.examples, newEntry.examples, 5);
        merged.exampleTranslations = mergeLists(oldEntry.exampleTranslations, newEntry.exampleTranslations, 5);
        merged.synonyms = mergeLists(oldEntry.synonyms, newEntry.synonyms, 12);
        merged.relatedWords = mergeLists(oldEntry.relatedWords, newEntry.relatedWords, 12);
        merged.source = firstNonBlank(newEntry.source, oldEntry.source);
        merged.updatedAt = Math.max(oldEntry.updatedAt, newEntry.updatedAt);
        merged.partial = newEntry.partial && !oldEntry.hasDisplayableData();
        merged.fromCache = false;
        return merged;
    }

    private static String firstNonBlank(String first, String second) {
        if (first != null && !first.trim().isEmpty()) return first.trim();
        return second == null ? "" : second.trim();
    }

    private static List<String> mergeLists(List<String> first, List<String> second, int limit) {
        List<String> merged = new ArrayList<>();
        if (first != null) {
            for (String value : first) {
                if (value != null && !value.trim().isEmpty() && !merged.contains(value.trim())) {
                    merged.add(value.trim());
                }
            }
        }
        if (second != null) {
            for (String value : second) {
                if (value != null && !value.trim().isEmpty() && !merged.contains(value.trim())) {
                    merged.add(value.trim());
                }
                if (merged.size() >= limit) break;
            }
        }
        return merged;
    }

    private static String appendSource(String existing, String sourceName) {
        if (sourceName == null || sourceName.trim().isEmpty()) {
            return existing;
        }
        if (existing == null || existing.trim().isEmpty()) {
            return sourceName.trim();
        }
        if (existing.contains(sourceName.trim())) {
            return existing;
        }
        return existing + ", " + sourceName.trim();
    }

    private static String joinLines(List<String> values) {
        if (values == null || values.isEmpty()) return "";
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (value == null || value.trim().isEmpty()) continue;
            if (builder.length() > 0) builder.append('\n');
            builder.append(value.trim());
        }
        return builder.toString();
    }

    private static List<String> splitLines(String text) {
        List<String> values = new ArrayList<>();
        if (text == null || text.trim().isEmpty()) return values;
        String[] parts = text.split("\\n");
        for (String part : parts) {
            String item = part.trim();
            if (!item.isEmpty()) values.add(item);
        }
        return values;
    }
}
