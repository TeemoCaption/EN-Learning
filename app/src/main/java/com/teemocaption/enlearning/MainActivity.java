package com.teemocaption.enlearning;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.TextView;
import android.widget.Toast;

import com.teemocaption.enlearning.data.AppDatabase;
import com.teemocaption.enlearning.data.UserWord;
import com.teemocaption.enlearning.data.WordEntry;
import com.teemocaption.enlearning.data.WordRepository;
import com.teemocaption.enlearning.importing.DocumentTextReader;
import com.teemocaption.enlearning.net.WordApiClient;
import com.teemocaption.enlearning.util.SpeechController;
import com.teemocaption.enlearning.util.WordNormalizer;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQUEST_IMPORT_DOCUMENT = 4101;
    private static final int COLOR_BG = 0xFFF7F3EA;
    private static final int COLOR_SURFACE = 0xFFFFFFFF;
    private static final int COLOR_INK = 0xFF253247;
    private static final int COLOR_MUTED = 0xFF667085;
    private static final int COLOR_MINT = 0xFFA8EACF;
    private static final int COLOR_MINT_DARK = 0xFF2F8C78;
    private static final int COLOR_TEAL = 0xFF2EA9B5;
    private static final int COLOR_CORAL = 0xFFFF8A7A;
    private static final int COLOR_LEMON = 0xFFFFE7A8;
    private static final int COLOR_LILAC = 0xFFEADDFE;
    private static final int COLOR_BLUE = 0xFF78A9FF;
    private static final int COLOR_ALPACA_DARK = 0xFFD7A985;

    private AppDatabase database;
    private WordRepository repository;
    private DocumentTextReader documentTextReader;
    private SpeechController speechController;
    private ExecutorService executor;
    private Handler mainHandler;
    private LinearLayout content;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        database = new AppDatabase(this);
        repository = new WordRepository(database, new WordApiClient());
        documentTextReader = new DocumentTextReader();
        speechController = new SpeechController(this);
        executor = Executors.newFixedThreadPool(4);
        mainHandler = new Handler(Looper.getMainLooper());
        buildShell();
        showHome();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (speechController != null) speechController.shutdown();
        if (executor != null) executor.shutdownNow();
        if (database != null) database.close();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_IMPORT_DOCUMENT && resultCode == RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri != null) handleImport(uri);
        }
    }

    private void buildShell() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(COLOR_BG);

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.HORIZONTAL);
        hero.setGravity(Gravity.CENTER_VERTICAL);
        hero.setPadding(dp(16), dp(14), dp(16), dp(10));
        hero.setBackground(makeBg(COLOR_SURFACE, 0x00FFFFFF, 0));

        ImageView mascot = new ImageView(this);
        mascot.setImageResource(R.drawable.ic_alpaca);
        mascot.setBackground(makeBg(0xFFFFF8EE, COLOR_ALPACA_DARK, 8));
        mascot.setPadding(dp(5), dp(4), dp(5), dp(4));
        hero.addView(mascot, new LinearLayout.LayoutParams(dp(58), dp(50)));

        LinearLayout heroText = new LinearLayout(this);
        heroText.setOrientation(LinearLayout.VERTICAL);
        heroText.setPadding(dp(12), 0, 0, 0);
        TextView title = new TextView(this);
        title.setText("Alpaca English");
        title.setTextColor(COLOR_INK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 25);
        TextView subtitle = new TextView(this);
        subtitle.setText("課程與單字，都讓小羊駝陪你慢慢學。");
        subtitle.setTextColor(COLOR_MUTED);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        subtitle.setSingleLine(false);
        heroText.addView(title);
        heroText.addView(subtitle);
        hero.addView(heroText, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(hero, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.setPadding(dp(10), dp(8), dp(10), dp(8));
        nav.setBackgroundColor(COLOR_BG);
        root.addView(nav, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        nav.addView(navButton("主頁", R.drawable.ic_home, v -> showHome()), buttonWeight());
        nav.addView(navButton("單字", R.drawable.ic_book, v -> showVocabularyHome()), buttonWeight());
        nav.addView(navButton("搜尋", R.drawable.ic_search, v -> showSearch()), buttonWeight());
        nav.addView(navButton("收藏", R.drawable.ic_book, v -> showBook()), buttonWeight());
        nav.addView(navButton("匯入", R.drawable.ic_import, v -> showImport()), buttonWeight());

        ScrollView scrollView = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(16), dp(6), dp(16), dp(24));
        scrollView.addView(content);
        root.addView(scrollView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));

        setContentView(root);
    }

    private void showHome() {
        resetContent();
        addMonsterPanel("今天想讓小羊駝陪你學什麼？",
                "先選一個方向開始。課程會放多益文法教學，單字會進入搜尋、匯入、收藏與朗讀功能。");

        content.addView(homeFeatureCard(
                R.drawable.ic_home,
                "課程",
                "多益文法教學",
                "文法重點、題型整理與練習會放在這裡。",
                0xFFFFF1C7,
                0xFFFFC857,
                v -> showCoursePlaceholder()), fullWidth());

        content.addView(homeFeatureCard(
                R.drawable.ic_book,
                "單字",
                "搜尋、匯入、收藏",
                "查中文意思、音標、例句、同義字與近義字。",
                0xFFE0F7EF,
                COLOR_MINT_DARK,
                v -> showVocabularyHome()), fullWidth());
    }

    private void showVocabularyHome() {
        resetContent();
        addMonsterPanel("今天想學什麼單字？",
                "可以手動搜尋，也可以匯入文件。小羊駝會整理中文意思、音標、例句、同義字、近義字，還能朗讀英文。");

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.addView(actionCard(R.drawable.ic_search, "開始搜尋", "查詢單字", COLOR_MINT, COLOR_MINT_DARK, v -> showSearch()), buttonWeight());
        actions.addView(actionCard(R.drawable.ic_import, "匯入文件", "建立單字庫", COLOR_LEMON, 0xFFFFD166, v -> showImport()), buttonWeight());
        content.addView(actions, fullWidth());

        runBackground(() -> database.getRecentSearches(5), recent -> {
            if (recent.isEmpty()) return;
            addSubheading("最近搜尋");
            for (String word : recent) {
                content.addView(wordRow(word, "", v -> lookupAndShow(word)));
            }
        });
    }

    private void showCoursePlaceholder() {
        resetContent();
        addMonsterPanel("課程功能準備中",
                "這裡會接多益文法教學。現在先完成單字功能，小羊駝會把課程入口先乖乖留好。");
        content.addView(primaryButton("前往單字", R.drawable.ic_book, v -> showVocabularyHome()), fullWidth());
    }

    private void showSearch() {
        resetContent();
        addHeading("羊駝單字搜尋");
        addBody("輸入英文單字，小羊駝會優先上網找資料；成功後會存進本機快取，離線時也能看已查過的單字。");

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("例如 revenue、expand、companies");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setTextColor(COLOR_INK);
        input.setHintTextColor(0xFF9CA3AF);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        input.setPadding(dp(14), dp(10), dp(14), dp(10));
        input.setBackground(makeBg(COLOR_SURFACE, COLOR_MINT, 8));
        content.addView(input, fullWidth());

        Button button = primaryButton("搜尋", R.drawable.ic_search, v -> lookupAndShow(input.getText().toString()));
        content.addView(button, fullWidth());

        runBackground(() -> database.getRecentSearches(10), recent -> {
            if (recent.isEmpty()) return;
            addSubheading("搜尋紀錄");
            for (String word : recent) {
                content.addView(wordRow(word, "查看", v -> lookupAndShow(word)));
            }
        });
    }

    private void lookupAndShow(String rawWord) {
        List<String> candidates = WordNormalizer.lookupCandidates(rawWord);
        if (candidates.isEmpty()) {
            Toast.makeText(this, "請輸入英文單字喔。", Toast.LENGTH_SHORT).show();
            return;
        }
        showLoading("正在優先查詢網路資料：" + candidates.get(0));
        runBackground(() -> repository.lookupNetworkFirst(rawWord), this::showWordDetail);
    }

    private void showWordDetail(WordEntry entry) {
        resetContent();
        if (entry == null) {
            addHeading("小羊駝還沒找到");
            addBody("目前無法取得這個單字，已保留到補查清單。");
            return;
        }

        addWordStudyCard(entry);

        UserWord userWord = database.getUserWord(entry.word);
        if (userWord != null) addFamiliarityControls(entry.word, userWord.familiarity);
        addClickableWordListField("同義字", entry.synonyms);
        addClickableWordListField("近義字", entry.relatedWords);
    }

    private void addFamiliarityControls(String word, int familiarity) {
        addSubheading("熟悉度：" + familiarity + " / 5");
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(secondaryButton("降低", v -> {
            database.updateFamiliarity(word, familiarity - 1);
            showWordDetail(database.getWord(word));
        }), buttonWeight());
        row.addView(secondaryButton("提高", v -> {
            database.updateFamiliarity(word, familiarity + 1);
            showWordDetail(database.getWord(word));
        }), buttonWeight());
        row.addView(dangerButton("移除", v -> {
            database.removeUserWord(word);
            Toast.makeText(this, "已從單字本移除。", Toast.LENGTH_SHORT).show();
            showBook();
        }), buttonWeight());
        content.addView(row, fullWidth());
    }

    private void showBook() {
        resetContent();
        addHeading("收藏單字");
        addBody("這裡會顯示手動收藏與文件匯入後補齊的單字。");
        showLoadingInline("正在整理收藏...");
        runBackground(() -> database.getWordsForBook(), words -> {
            resetContent();
            addHeading("收藏單字");
            if (words.isEmpty()) {
                addMonsterPanel("收藏還是空的",
                        "先餵一個單字，或丟一份文件給小羊駝，牠就會開始整理單字卡。");
                content.addView(primaryButton("去搜尋", R.drawable.ic_search, v -> showSearch()), fullWidth());
                content.addView(secondaryButton("去匯入", R.drawable.ic_import, v -> showImport()), fullWidth());
                return;
            }
            for (WordEntry entry : words) {
                content.addView(wordRow(entry.word, entry.chineseMeaning, v -> showWordDetail(entry)));
            }
        });
    }

    private void showImport() {
        resetContent();
        addHeading("匯入文件");
        addBody("支援 txt、csv、docx 與可選取文字的 pdf。掃描型 PDF 第一階段會提示不支援圖片文字辨識。");
        content.addView(primaryButton("選擇文件", R.drawable.ic_import, v -> openDocumentPicker()), fullWidth());
        addBody("匯入後會先抽出英文單字、去重，再逐字網路查詢中文意思、音標、例句、同義字與近義字。");
    }

    private void openDocumentPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/plain",
                "text/csv",
                "application/pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        });
        startActivityForResult(intent, REQUEST_IMPORT_DOCUMENT);
    }

    private void handleImport(Uri uri) {
        resetContent();
        addHeading("讀取文件中");
        TextView progress = addBody("正在讀取文件...");

        executor.execute(() -> {
            ImportSummary summary = new ImportSummary();
            try {
                DocumentTextReader.DocumentText document = documentTextReader.read(this, uri);
                summary.fileName = document.displayName;
                summary.format = document.extension;
                if (document.likelyScannedPdf) {
                    summary.scannedPdf = true;
                    postImportResult(summary);
                    return;
                }

                List<String> words = WordNormalizer.extractWords(document.text, 1000);
                summary.total = words.size();
                summary.unique = words.size();
                long batchId = database.insertImportBatch(document.displayName, document.extension, summary.total, summary.unique);

                for (int i = 0; i < words.size(); i++) {
                    String item = words.get(i);
                    WordRepository.ImportWordStatus status = repository.enrichImportedWord(item, document.displayName);
                    if (status == WordRepository.ImportWordStatus.SUCCESS) summary.success++;
                    else if (status == WordRepository.ImportWordStatus.PARTIAL) summary.partial++;
                    else summary.failed++;

                    if (i % 5 == 0 || i == words.size() - 1) {
                        int done = i + 1;
                        mainHandler.post(() -> progress.setText("已整理 " + done + " / " + words.size()
                                + " 個單字，小羊駝正在整理。"));
                    }
                }

                database.updateImportBatch(batchId, summary.success, summary.partial, summary.failed);
            } catch (Exception error) {
                summary.error = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            postImportResult(summary);
        });
    }

    private void postImportResult(ImportSummary summary) {
        mainHandler.post(() -> showImportResult(summary));
    }

    private void showImportResult(ImportSummary summary) {
        resetContent();
        addHeading("匯入完成");
        if (summary.scannedPdf) {
            addBody("這份 PDF 可能是掃描圖片型文件，目前第一階段尚未支援圖片文字辨識。");
            content.addView(secondaryButton("重新選擇", R.drawable.ic_import, v -> openDocumentPicker()), fullWidth());
            return;
        }
        if (summary.error != null && !summary.error.trim().isEmpty()) {
            addBody("匯入失敗：" + summary.error);
            content.addView(secondaryButton("重新選擇", R.drawable.ic_import, v -> openDocumentPicker()), fullWidth());
            return;
        }
        addField("文件", summary.fileName);
        addField("格式", summary.format);
        addField("去重後單字數", String.valueOf(summary.unique));
        addField("成功補齊", String.valueOf(summary.success));
        addField("部分補齊", String.valueOf(summary.partial));
        addField("需補查資料", String.valueOf(summary.failed));
        content.addView(primaryButton("查看收藏", R.drawable.ic_book, v -> showBook()), fullWidth());
    }

    private void showPending() {
        resetContent();
        addHeading("補查清單");
        addBody("網路失敗、查無完整資料或匯入時部分補齊的單字會先放在這裡。");
        runBackground(() -> database.getPendingWords(), words -> {
            resetContent();
            addHeading("補查清單");
            if (words.isEmpty()) {
                addMonsterPanel("目前沒有需補查單字",
                        "目前沒有需補查單字，小羊駝暫時不用加班。");
                return;
            }
            content.addView(primaryButton("全部重查", R.drawable.ic_pending, v -> retryPending(words)), fullWidth());
            for (String word : words) {
                content.addView(wordRow(word, "重新補查", v -> lookupAndShow(word)));
            }
        });
    }

    private void retryPending(List<String> words) {
        showLoading("正在重新補查單字...");
        executor.execute(() -> {
            for (String word : words) {
                repository.lookupNetworkFirst(word);
            }
            mainHandler.post(this::showPending);
        });
    }

    private void showLoading(String message) {
        resetContent();
        addHeading("查詢中");
        addBody(message);
    }

    private void showLoadingInline(String message) {
        addBody(message);
    }

    private void resetContent() {
        content.removeAllViews();
    }

    private TextView addHeading(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(COLOR_INK);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setGravity(Gravity.START);
        view.setPadding(0, dp(10), 0, dp(8));
        content.addView(view, fullWidth());
        return view;
    }

    private TextView addSubheading(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(COLOR_INK);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setPadding(0, dp(18), 0, dp(6));
        content.addView(view, fullWidth());
        return view;
    }

    private TextView addBody(String text) {
        TextView view = new TextView(this);
        view.setText(text == null ? "" : text);
        view.setTextColor(COLOR_MUTED);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        view.setLineSpacing(0, 1.2f);
        view.setPadding(0, dp(4), 0, dp(10));
        content.addView(view, fullWidth());
        return view;
    }

    private void addBadge(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(0xFF92400E);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setBackground(makeBg(COLOR_LEMON, 0xFFFFD166, 8));
        view.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout.LayoutParams params = fullWidth();
        params.setMargins(0, dp(4), 0, dp(8));
        content.addView(view, params);
    }

    private void addField(String label, String value) {
        if (value == null || value.trim().isEmpty()) return;
        addSubheading(label);
        addBody(value.trim());
    }

    private void addListField(String label, List<String> values, boolean speakable) {
        if (values == null || values.isEmpty()) return;
        addSubheading(label);
        for (String value : values) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);

            TextView text = new TextView(this);
            text.setText("• " + value);
            text.setTextColor(COLOR_MUTED);
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            text.setPadding(0, dp(4), dp(8), dp(4));
            row.addView(text, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            if (speakable) row.addView(iconButton("朗讀例句", v -> speechController.speak(value)),
                    new LinearLayout.LayoutParams(dp(48), dp(42)));
            content.addView(row, fullWidth());
        }
    }

    private void addClickableWordListField(String label, List<String> values) {
        if (values == null || values.isEmpty()) return;
        addSubheading(label);

        LinearLayout row = null;
        int index = 0;
        for (String rawValue : values) {
            String value = rawValue == null ? "" : rawValue.trim();
            if (value.isEmpty()) continue;

            if (index % 2 == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                content.addView(row, fullWidth());
            }

            TextView chip = new TextView(this);
            chip.setText(value);
            chip.setTextColor(COLOR_INK);
            chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            chip.setTypeface(Typeface.DEFAULT_BOLD);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setMinHeight(dp(44));
            chip.setPadding(dp(12), dp(8), dp(12), dp(8));
            chip.setBackground(makeBg(0xFFF3E8FF, 0xFFD8B4FE, 8));
            chip.setClickable(true);
            chip.setFocusable(true);
            chip.setContentDescription("查詢 " + value);
            chip.setOnClickListener(v -> lookupAndShow(value));

            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    0,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    1f);
            params.setMargins(index % 2 == 0 ? 0 : dp(6), 0, index % 2 == 0 ? dp(6) : 0, dp(8));
            if (row != null) row.addView(chip, params);
            index++;
        }

        if (row != null && row.getChildCount() == 1) {
            Space spacer = new Space(this);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    0,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    1f);
            params.setMargins(dp(6), 0, 0, dp(8));
            row.addView(spacer, params);
        }
    }

    private void addWordStudyCard(WordEntry entry) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(14), dp(18), dp(18));
        card.setMinimumHeight(dp(520));
        card.setBackground(makeBg(COLOR_SURFACE, 0xFFF1E2CC, 8));
        card.setElevation(dp(2));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        TextView report = new TextView(this);
        report.setText("回報");
        report.setTextColor(0xFFB8B8B8);
        report.setTypeface(Typeface.DEFAULT_BOLD);
        report.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        top.addView(report, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        ImageButton favorite = roundIconButton(R.drawable.ic_heart, "加入收藏", 0xFFE83E65, 0xFFE83E65, v -> {
            repository.addToBook(entry, "manual", "手動搜尋");
            Toast.makeText(this, "已加入收藏。", Toast.LENGTH_SHORT).show();
        });
        favorite.setColorFilter(Color.WHITE);
        LinearLayout.LayoutParams favoriteParams = new LinearLayout.LayoutParams(dp(42), dp(42));
        favoriteParams.setMargins(dp(8), 0, 0, 0);
        top.addView(favorite, favoriteParams);
        card.addView(top, fullWidthNoMargin());

        LinearLayout wordRow = new LinearLayout(this);
        wordRow.setOrientation(LinearLayout.HORIZONTAL);
        wordRow.setGravity(Gravity.CENTER_VERTICAL);
        wordRow.setPadding(0, dp(58), 0, 0);

        LinearLayout mainText = new LinearLayout(this);
        mainText.setOrientation(LinearLayout.VERTICAL);
        TextView word = new TextView(this);
        word.setText(entry.word);
        word.setTextColor(COLOR_TEAL);
        word.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        word.setTypeface(Typeface.DEFAULT_BOLD);
        mainText.addView(word);

        if (!isBlank(entry.phonetic)) {
            TextView phonetic = new TextView(this);
            phonetic.setText(entry.phonetic);
            phonetic.setTextColor(0xFF8A8A8A);
            phonetic.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
            phonetic.setPadding(0, dp(4), 0, dp(8));
            mainText.addView(phonetic);
        }
        wordRow.addView(mainText, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        ImageButton speak = lightIconButton("發音", v -> speechController.speak(entry.word));
        wordRow.addView(speak, new LinearLayout.LayoutParams(dp(44), dp(44)));
        card.addView(wordRow, fullWidthNoMargin());

        addMeaningRows(card, entry);

        String example = displayExample(entry);
        if (!isBlank(example)) {
            addExampleCard(card, example, displayExampleTranslation(entry));
        }

        content.addView(card, fullWidth());

        if (entry.fromCache) addBadge("目前顯示本機快取資料");
    }

    private void addMeaningRows(LinearLayout parent, WordEntry entry) {
        List<String> parts = splitPartOfSpeech(entry.partOfSpeech);
        String meaning = isBlank(entry.chineseMeaning) ? "中文意思補查中" : entry.chineseMeaning.trim();
        if (parts.isEmpty()) {
            parent.addView(meaningRow("義", meaning), compactFullWidth());
            return;
        }
        for (String part : parts) {
            parent.addView(meaningRow(partLabel(part), meaning), compactFullWidth());
        }
    }

    private LinearLayout meaningRow(String part, String meaning) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(4), 0, dp(2));

        TextView partView = new TextView(this);
        partView.setText(part);
        partView.setGravity(Gravity.CENTER);
        partView.setTextColor(0xFF8A8A8A);
        partView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        partView.setBackground(makeBg(0x00FFFFFF, 0xFFCFCFCF, 8));
        row.addView(partView, new LinearLayout.LayoutParams(dp(54), dp(36)));

        TextView meaningView = new TextView(this);
        meaningView.setText(meaning);
        meaningView.setTextColor(0xFF4B5563);
        meaningView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        meaningView.setTypeface(Typeface.DEFAULT_BOLD);
        meaningView.setPadding(dp(12), 0, dp(8), 0);
        row.addView(meaningView, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        return row;
    }

    private void addExampleCard(LinearLayout parent, String example, String translation) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(12), dp(12), dp(10), dp(12));
        card.setBackground(makeBg(0xFFFAFAFA, 0xFFE5E7EB, 8));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);

        TextView label = new TextView(this);
        label.setText("例句");
        label.setTextColor(0xFF9CA3AF);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        texts.addView(label);

        TextView exampleView = new TextView(this);
        exampleView.setText(example);
        exampleView.setTextColor(0xFF4B5563);
        exampleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        exampleView.setLineSpacing(0, 1.18f);
        exampleView.setPadding(0, dp(6), dp(8), 0);
        texts.addView(exampleView);

        if (!isBlank(translation)) {
            TextView translationView = new TextView(this);
            translationView.setText(translation);
            translationView.setTextColor(0xFF6B7280);
            translationView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            translationView.setLineSpacing(0, 1.18f);
            translationView.setPadding(0, dp(10), dp(8), 0);
            texts.addView(translationView);
        }

        card.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        ImageButton speak = lightIconButton("朗讀例句", v -> speechController.speak(example));
        card.addView(speak, new LinearLayout.LayoutParams(dp(42), dp(42)));

        LinearLayout.LayoutParams params = fullWidthNoMargin();
        params.setMargins(0, dp(14), 0, dp(8));
        parent.addView(card, params);
    }

    private LinearLayout wordRow(String title, String subtitle, View.OnClickListener listener) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(10), dp(10), dp(10));
        row.setBackground(makeBg(COLOR_SURFACE, 0xFFF1E2CC, 8));
        row.setElevation(dp(1));
        row.setClickable(true);
        row.setFocusable(true);
        row.setContentDescription(title + (subtitle == null || subtitle.trim().isEmpty() ? "" : "，" + subtitle));
        row.setOnClickListener(listener);

        ImageView monster = new ImageView(this);
        monster.setImageResource(R.drawable.ic_alpaca);
        monster.setBackground(makeBg(0xFFFFF8EE, COLOR_ALPACA_DARK, 8));
        monster.setPadding(dp(4), dp(4), dp(4), dp(4));
        row.addView(monster, new LinearLayout.LayoutParams(dp(46), dp(46)));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(dp(12), 0, dp(8), 0);
        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(COLOR_INK);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        texts.addView(titleView);
        if (subtitle != null && !subtitle.trim().isEmpty()) {
            TextView subView = new TextView(this);
            subView.setText(subtitle);
            subView.setTextColor(COLOR_MUTED);
            subView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            subView.setSingleLine(true);
            subView.setEllipsize(TextUtils.TruncateAt.END);
            texts.addView(subView);
        }
        row.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        ImageView arrow = new ImageView(this);
        arrow.setImageResource(R.drawable.ic_chevron_right);
        arrow.setColorFilter(COLOR_MUTED);
        row.addView(arrow, new LinearLayout.LayoutParams(dp(24), dp(24)));

        LinearLayout.LayoutParams params = fullWidth();
        params.setMargins(0, 0, 0, dp(8));
        row.setLayoutParams(params);
        return row;
    }

    private LinearLayout navButton(String text, int iconRes, View.OnClickListener listener) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(4), dp(6), dp(4), dp(6));
        item.setBackground(makeBg(COLOR_LILAC, 0xFFD8B4FE, 8));
        item.setClickable(true);
        item.setFocusable(true);
        item.setContentDescription(text);
        item.setOnClickListener(listener);

        ImageView icon = new ImageView(this);
        icon.setImageResource(iconRes);
        icon.setColorFilter(COLOR_INK);
        item.addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));

        TextView label = new TextView(this);
        label.setText(text);
        label.setTextColor(COLOR_INK);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        label.setGravity(Gravity.CENTER);
        item.addView(label);
        return item;
    }

    private LinearLayout actionCard(int iconRes, String title, String subtitle, int color, int strokeColor, View.OnClickListener listener) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(dp(10), dp(12), dp(10), dp(12));
        card.setMinimumHeight(dp(104));
        card.setBackground(makeBg(color, strokeColor, 8));
        card.setElevation(dp(2));
        card.setClickable(true);
        card.setFocusable(true);
        card.setContentDescription(title + "，" + subtitle);
        card.setOnClickListener(listener);

        ImageView icon = new ImageView(this);
        icon.setImageResource(iconRes);
        icon.setColorFilter(COLOR_INK);
        icon.setBackground(makeBg(0x66FFFFFF, 0x00FFFFFF, 8));
        icon.setPadding(dp(8), dp(8), dp(8), dp(8));
        card.addView(icon, new LinearLayout.LayoutParams(dp(44), dp(44)));

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(COLOR_INK);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        titleView.setGravity(Gravity.CENTER);
        titleView.setSingleLine(false);
        card.addView(titleView);

        TextView subView = new TextView(this);
        subView.setText(subtitle);
        subView.setTextColor(COLOR_MUTED);
        subView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        subView.setGravity(Gravity.CENTER);
        subView.setSingleLine(false);
        card.addView(subView);
        return card;
    }

    private LinearLayout homeFeatureCard(int iconRes, String title, String subtitle, String body,
                                         int color, int strokeColor, View.OnClickListener listener) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setMinimumHeight(dp(142));
        card.setBackground(makeBg(color, strokeColor, 8));
        card.setElevation(dp(2));
        card.setClickable(true);
        card.setFocusable(true);
        card.setContentDescription(title + "，" + subtitle);
        card.setOnClickListener(listener);

        ImageView icon = new ImageView(this);
        icon.setImageResource(iconRes);
        icon.setColorFilter(COLOR_INK);
        icon.setBackground(makeBg(0x77FFFFFF, 0x00FFFFFF, 8));
        icon.setPadding(dp(12), dp(12), dp(12), dp(12));
        card.addView(icon, new LinearLayout.LayoutParams(dp(68), dp(68)));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(dp(16), 0, 0, 0);

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(COLOR_INK);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        texts.addView(titleView);

        TextView subtitleView = new TextView(this);
        subtitleView.setText(subtitle);
        subtitleView.setTextColor(COLOR_INK);
        subtitleView.setTypeface(Typeface.DEFAULT_BOLD);
        subtitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        subtitleView.setPadding(0, dp(2), 0, dp(4));
        texts.addView(subtitleView);

        TextView bodyView = new TextView(this);
        bodyView.setText(body);
        bodyView.setTextColor(COLOR_MUTED);
        bodyView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        bodyView.setLineSpacing(0, 1.15f);
        texts.addView(bodyView);

        card.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        ImageView arrow = new ImageView(this);
        arrow.setImageResource(R.drawable.ic_chevron_right);
        arrow.setColorFilter(COLOR_INK);
        card.addView(arrow, new LinearLayout.LayoutParams(dp(26), dp(26)));

        return card;
    }

    private Button primaryButton(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(COLOR_INK);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(makeBg(COLOR_MINT, COLOR_MINT_DARK, 8));
        button.setMinHeight(dp(52));
        button.setOnClickListener(listener);
        return button;
    }

    private Button primaryButton(String text, int iconRes, View.OnClickListener listener) {
        Button button = primaryButton(text, listener);
        addButtonIcon(button, iconRes);
        return button;
    }

    private Button secondaryButton(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(COLOR_INK);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(makeBg(0xFFFFE4D6, COLOR_CORAL, 8));
        button.setMinHeight(dp(52));
        button.setOnClickListener(listener);
        return button;
    }

    private Button secondaryButton(String text, int iconRes, View.OnClickListener listener) {
        Button button = secondaryButton(text, listener);
        addButtonIcon(button, iconRes);
        return button;
    }

    private void addButtonIcon(Button button, int iconRes) {
        Drawable icon = getDrawable(iconRes);
        if (icon == null) return;
        icon = icon.mutate();
        icon.setTint(COLOR_INK);
        icon.setBounds(0, 0, dp(22), dp(22));
        button.setCompoundDrawables(icon, null, null, null);
        button.setCompoundDrawablePadding(dp(8));
        button.setGravity(Gravity.CENTER);
    }

    private Button dangerButton(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(makeBg(0xFFEF4444, 0xFFB91C1C, 8));
        button.setOnClickListener(listener);
        return button;
    }

    private ImageButton iconButton(String description, View.OnClickListener listener) {
        return roundIconButton(R.drawable.ic_volume, description, COLOR_MINT, COLOR_MINT_DARK, listener);
    }

    private ImageButton lightIconButton(String description, View.OnClickListener listener) {
        return roundIconButton(R.drawable.ic_volume, description, 0xFFF1F3F5, 0xFFE5E7EB, listener);
    }

    private ImageButton roundIconButton(int iconRes, String description, int color, int strokeColor, View.OnClickListener listener) {
        ImageButton button = new ImageButton(this);
        button.setImageResource(iconRes);
        button.setContentDescription(description);
        button.setBackground(makeBg(color, strokeColor, 8));
        button.setColorFilter(COLOR_INK);
        button.setPadding(dp(10), dp(10), dp(10), dp(10));
        button.setOnClickListener(listener);
        return button;
    }

    private void addMonsterPanel(String title, String body) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.HORIZONTAL);
        panel.setGravity(Gravity.CENTER_VERTICAL);
        panel.setPadding(dp(14), dp(14), dp(14), dp(14));
        panel.setBackground(makeBg(COLOR_LEMON, 0xFFFFD166, 8));

        ImageView monster = new ImageView(this);
        monster.setImageResource(R.drawable.ic_alpaca);
        monster.setBackground(makeBg(0xFFFFF8EE, COLOR_ALPACA_DARK, 8));
        monster.setPadding(dp(5), dp(5), dp(5), dp(5));
        panel.addView(monster, new LinearLayout.LayoutParams(dp(58), dp(58)));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(dp(12), 0, 0, 0);

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(COLOR_INK);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        texts.addView(titleView);

        TextView bodyView = new TextView(this);
        bodyView.setText(body);
        bodyView.setTextColor(COLOR_MUTED);
        bodyView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        bodyView.setLineSpacing(0, 1.18f);
        texts.addView(bodyView);

        panel.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        content.addView(panel, fullWidth());
    }

    private GradientDrawable makeBg(int color, int strokeColor, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if ((strokeColor >>> 24) != 0) {
            drawable.setStroke(dp(1), strokeColor);
        }
        return drawable;
    }

    private List<String> splitPartOfSpeech(String partOfSpeech) {
        java.util.ArrayList<String> values = new java.util.ArrayList<>();
        if (isBlank(partOfSpeech)) return values;
        String[] pieces = partOfSpeech.split("[,;/]+|\\band\\b");
        for (String piece : pieces) {
            String value = piece == null ? "" : piece.trim();
            if (!value.isEmpty() && !values.contains(value)) values.add(value);
            if (values.size() >= 3) break;
        }
        return values;
    }

    private String partLabel(String part) {
        String lower = part == null ? "" : part.trim().toLowerCase();
        if (lower.startsWith("noun")) return "n.";
        if (lower.startsWith("verb")) return "v.";
        if (lower.startsWith("adjective")) return "adj.";
        if (lower.startsWith("adverb")) return "adv.";
        if (lower.startsWith("pronoun")) return "pron.";
        if (lower.startsWith("preposition")) return "prep.";
        if (lower.startsWith("conjunction")) return "conj.";
        if (lower.startsWith("interjection")) return "int.";
        return part == null || part.trim().isEmpty() ? "義" : part.trim();
    }

    private String displayExample(WordEntry entry) {
        if (entry != null && entry.examples != null && !entry.examples.isEmpty()) {
            String example = entry.examples.get(0);
            if (!isBlank(example)) return example.trim();
        }
        return "";
    }

    private String displayExampleTranslation(WordEntry entry) {
        if (entry != null && entry.exampleTranslations != null && !entry.exampleTranslations.isEmpty()) {
            String translation = entry.exampleTranslations.get(0);
            if (!isBlank(translation)) return translation.trim();
        }
        return "";
    }

    private boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private LinearLayout.LayoutParams fullWidth() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(4), 0, dp(8));
        return params;
    }

    private LinearLayout.LayoutParams fullWidthNoMargin() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams compactFullWidth() {
        LinearLayout.LayoutParams params = fullWidthNoMargin();
        params.setMargins(0, dp(2), 0, dp(2));
        return params;
    }

    private LinearLayout.LayoutParams buttonWeight() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(dp(4), 0, dp(4), 0);
        return params;
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP,
                value,
                getResources().getDisplayMetrics());
    }

    private <T> void runBackground(BackgroundTask<T> task, UiCallback<T> callback) {
        executor.execute(() -> {
            try {
                T result = task.run();
                mainHandler.post(() -> callback.onResult(result));
            } catch (Exception error) {
                mainHandler.post(() -> Toast.makeText(
                        this,
                        "操作失敗：" + (error.getMessage() == null ? error.toString() : error.getMessage()),
                        Toast.LENGTH_LONG).show());
            }
        });
    }

    private interface BackgroundTask<T> {
        T run() throws Exception;
    }

    private interface UiCallback<T> {
        void onResult(T result);
    }

    private static class ImportSummary {
        String fileName = "";
        String format = "";
        int total;
        int unique;
        int success;
        int partial;
        int failed;
        boolean scannedPdf;
        String error;
    }
}
