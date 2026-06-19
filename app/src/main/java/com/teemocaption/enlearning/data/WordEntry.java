package com.teemocaption.enlearning.data;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class WordEntry {
    public String word;
    public String originalWord;
    public String chineseMeaning;
    public String phonetic;
    public String partOfSpeech;
    public String englishDefinition;
    public List<String> examples = new ArrayList<>();
    public List<String> exampleTranslations = new ArrayList<>();
    public List<String> synonyms = new ArrayList<>();
    public List<String> relatedWords = new ArrayList<>();
    public String source;
    public long updatedAt;
    public boolean fromCache;
    public boolean partial;

    public WordEntry(String word) {
        this.word = word == null ? "" : word;
        this.originalWord = this.word;
        this.updatedAt = System.currentTimeMillis();
    }

    public boolean hasDisplayableData() {
        return notBlank(chineseMeaning)
                || notBlank(phonetic)
                || notBlank(englishDefinition)
                || !examples.isEmpty()
                || !exampleTranslations.isEmpty()
                || !synonyms.isEmpty()
                || !relatedWords.isEmpty();
    }

    public static List<String> cleanList(List<String> values, int maxItems) {
        if (values == null) return Collections.emptyList();
        List<String> cleaned = new ArrayList<>();
        for (String value : values) {
            if (value == null) continue;
            String item = value.trim();
            if (item.isEmpty() || cleaned.contains(item)) continue;
            cleaned.add(item);
            if (cleaned.size() >= maxItems) break;
        }
        return cleaned;
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
