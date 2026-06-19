package com.teemocaption.enlearning.util;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class WordNormalizer {
    private static final Pattern WORD_PATTERN = Pattern.compile("(?<![A-Za-z0-9])[A-Za-z]+(?:[-'][A-Za-z]+)?(?![A-Za-z0-9])");
    private static final Pattern ENGLISH_PHRASE_PATTERN = Pattern.compile(
            "[A-Za-z]+(?:[-'][A-Za-z]+)?(?:\\s+[A-Za-z]+(?:[-'][A-Za-z]+)?){0,3}");
    private static final Pattern TERM_PATTERN = Pattern.compile(
            "^[a-z]+(?:[-'][a-z]+)?(?: [a-z]+(?:[-'][a-z]+)?){0,3}$");

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
        if (cleaned.contains(" ")) {
            return new ArrayList<>(candidates);
        }

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
        String[] segments = text.split("[\\r\\n,;，；、\\t/／|]+");
        for (String segment : segments) {
            String term = normalizeImportedTerm(segment);
            if (isUsefulTerm(term)) {
                words.add(term);
            } else {
                addSingleWords(segment, words, limit);
            }
            if (words.size() >= limit) break;
        }
        return new ArrayList<>(words);
    }

    public static String lemmatize(String word) {
        String w = cleanInput(word);
        if (w.contains(" ")) {
            String[] pieces = w.split("\\s+");
            List<String> normalized = new ArrayList<>();
            for (String piece : pieces) {
                String normalizedWord = lemmatizeSingle(piece);
                if (!isEnglishToken(normalizedWord)) return "";
                normalized.add(normalizedWord);
            }
            return String.join(" ", normalized);
        }
        return lemmatizeSingle(w);
    }

    private static String lemmatizeSingle(String w) {
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
        String[] pieces = cleaned.split("\\s+");
        List<String> words = new ArrayList<>();
        for (String piece : pieces) {
            String word = piece
                    .replaceAll("^[^a-z]+|[^a-z]+$", "")
                    .replaceAll("[^a-z'-]", "");
            if (!word.isEmpty()) {
                words.add(word);
                if (words.size() >= 4) break;
            }
        }
        return String.join(" ", words);
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
        if (isUsefulTerm(word)) candidates.add(word);
    }

    private static void addSingleWords(String text, Set<String> words, int limit) {
        if (text == null) return;
        Matcher matcher = WORD_PATTERN.matcher(text);
        while (matcher.find()) {
            String word = normalizeQuery(matcher.group());
            if (isUsefulWord(word)) {
                words.add(word);
                if (words.size() >= limit) return;
            }
        }
    }

    private static String normalizeImportedTerm(String input) {
        if (input == null) return "";
        if (input.matches(".*[A-Za-z][0-9].*") || input.matches(".*[0-9][A-Za-z].*")) return "";
        String cleaned = input
                .replace('’', '\'')
                .replaceAll("^[^A-Za-z]+|[^A-Za-z]+$", "")
                .replaceAll("\\s+", " ")
                .trim();
        if (cleaned.isEmpty()) return "";
        if (cleaned.matches(".*[.!?。！？].*")) return "";
        if (!ENGLISH_PHRASE_PATTERN.matcher(cleaned).matches()) return "";

        String[] pieces = cleaned.split("\\s+");
        List<String> normalized = new ArrayList<>();
        for (String piece : pieces) {
            String word = normalizeQuery(piece);
            if (!isEnglishToken(word)) return "";
            normalized.add(word);
        }
        return String.join(" ", normalized);
    }

    private static boolean isUsefulTerm(String term) {
        if (term == null || term.trim().isEmpty()) return false;
        String cleaned = term.trim();
        if (!TERM_PATTERN.matcher(cleaned).matches()) return false;
        String[] pieces = cleaned.split("\\s+");
        if (pieces.length == 0 || pieces.length > 4) return false;
        if (pieces.length == 1) return isUsefulWord(pieces[0]);
        for (String piece : pieces) {
            if (!isEnglishToken(piece)) return false;
        }
        return true;
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
        return isEnglishToken(word);
    }

    private static boolean isEnglishToken(String word) {
        return word != null && word.matches("^[a-z]+(?:[-'][a-z]+)?$");
    }
}
