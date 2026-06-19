package com.teemocaption.enlearning.util;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.widget.Toast;

import java.util.Locale;

public class SpeechController implements TextToSpeech.OnInitListener {
    private final Context context;
    private TextToSpeech textToSpeech;
    private boolean ready;

    public SpeechController(Context context) {
        this.context = context.getApplicationContext();
        this.textToSpeech = new TextToSpeech(this.context, this);
    }

    @Override
    public void onInit(int status) {
        ready = status == TextToSpeech.SUCCESS;
        if (ready) {
            int result = textToSpeech.setLanguage(Locale.US);
            ready = result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED;
        }
    }

    public void speak(String text) {
        if (text == null || text.trim().isEmpty()) return;
        if (!ready || textToSpeech == null) {
            Toast.makeText(context, "系統英文語音尚未準備好，請確認手機已安裝英文語音資料。", Toast.LENGTH_SHORT).show();
            return;
        }
        textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "word-" + System.currentTimeMillis());
    }

    public void shutdown() {
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
    }
}
