package com.teemocaption.enlearning.util;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class WordNormalizer {
    private static final Pattern WORD_PATTERN = Pattern.compile("[A-Za-z]+(?:[-'][A-Za-z]+)?");

    private WordNormalizer() {
    }

    public static String normalizeQuery(String input) {
        return lemmatize(cleanInput(input));
    }

    public static String normalize(String input) {
        return normalizeQuery(input);
    }

    public static List<String> lookupCandidates(String input) {
        LinkedHashSet<String> candidates = new LinkedHashSet<>();
        String cleaned = cleanInput(input);
        addCandidate(candidates, cleaned);
        addCandidate(candidates, lemmatize(cleaned));

        if (cleaned.endsWith("ing") && cleaned.length() > 5) {
            String stem = cleaned.substring(0, cleaned.length() - 3);
            addCandidate(candidates, stem);
            addCandidate(candidates, removeDoubledEnding(stem));
            addCandidate(candidates, stem + "e");
        }
        if (cleaned.endsWith("ed") && cleaned.length() > 4) {
            String stem = cleaned.substring(0, cleaned.length() - 2);
            addCandidate(candidates, stem);
            addCandidate(candidates, removeDoubledEnding(stem));
            addCandidate(candidates, stem + "e");
        }
        if (cleaned.endsWith("ies") && cleaned.length() > 4) {
            addCandidate(candidates, cleaned.substring(0, cleaned.length() - 3) + "y");
        }
        if (cleaned.endsWith("es") && cleaned.length() > 4) {
            addCandidate(candidates, cleaned.substring(0, cleaned.length() - 2));
        }
        if (cleaned.endsWith("s") && cleaned.length() > 3 && !cleaned.endsWith("ss")) {
            addCandidate(candidates, cleaned.substring(0, cleaned.length() - 1));
        }
        return new ArrayList<>(candidates);
    }

    public static List<String> extractWords(String text, int limit) {
        Set<String> words = new LinkedHashSet<>();
        if (text == null || text.trim().isEmpty()) return new ArrayList<>();
        Matcher matcher = WORD_PATTERN.matcher(text);
        while (matcher.find()) {
            String word = normalizeQuery(matcher.group());
            if (isUsefulWord(word)) {
                words.add(word);
                if (words.size() >= limit) break;
            }
        }
        return new ArrayList<>(words);
    }

    public static String lemmatize(String word) {
        String w = cleanInput(word);
        if (w.length() <= 3) return w;
        if (w.endsWith("'s")) w = w.substring(0, w.length() - 2);
        if (w.endsWith("ies") && w.length() > 4) return w.substring(0, w.length() - 3) + "y";
        if (w.endsWith("ves") && w.length() > 4) return w.substring(0, w.length() - 3) + "f";
        if (w.endsWith("ied") && w.length() > 4) return w.substring(0, w.length() - 3) + "y";
        if (w.endsWith("ing") && w.length() > 5) {
            String stem = w.substring(0, w.length() - 3);
            if (stem.endsWith(stem.substring(stem.length() - 1) + stem.substring(stem.length() - 1))) {
                stem = stem.substring(0, stem.length() - 1);
            }
            if (needsSilentE(stem)) return stem + "e";
            return stem;
        }
        if (w.endsWith("ed") && w.length() > 4) {
            String stem = w.substring(0, w.length() - 2);
            String undoubled = removeDoubledEnding(stem);
            if (!undoubled.equals(stem)) return undoubled;
            if (needsSilentE(stem)) return stem + "e";
            return stem;
        }
        if (w.endsWith("es") && w.length() > 4) return w.substring(0, w.length() - 2);
        if (w.endsWith("s") && w.length() > 3 && !w.endsWith("ss")) return w.substring(0, w.length() - 1);
        return w;
    }

    private static String cleanInput(String input) {
        if (input == null) return "";
        String cleaned = input.trim().toLowerCase(Locale.US).replace('’', '\'');
        cleaned = cleaned.replaceAll("^[^a-z]+|[^a-z]+$", "");
        cleaned = cleaned.replaceAll("[^a-z'-]", "");
        return cleaned;
    }

    private static String removeDoubledEnding(String stem) {
        if (stem == null || stem.length() < 3) return stem;
        int last = stem.length() - 1;
        if (stem.charAt(last) == stem.charAt(last - 1)) {
            return stem.substring(0, last);
        }
        return stem;
    }

    private static void addCandidate(Set<String> candidates, String word) {
        if (isUsefulWord(word)) candidates.add(word);
    }

    private static boolean needsSilentE(String stem) {
        if (stem == null || stem.length() < 3) return false;
        return stem.endsWith("at")
                || stem.endsWith("id")
                || stem.endsWith("iv")
                || stem.endsWith("iz")
                || stem.endsWith("ov")
                || stem.endsWith("us")
                || stem.endsWith("os")
                || stem.endsWith("ak");
    }

    private static boolean isUsefulWord(String word) {
        if (word == null || word.length() < 2) return false;
        return !word.matches("^[a-z]$");
    }
}
