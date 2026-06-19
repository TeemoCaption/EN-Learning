package com.teemocaption.enlearning.importing;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.text.PDFTextStripper;

import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class DocumentTextReader {
    public DocumentText read(Context context, Uri uri) throws Exception {
        String displayName = resolveDisplayName(context, uri);
        String extension = resolveExtension(displayName);
        String text;
        boolean scannedPdf = false;

        if ("txt".equals(extension) || "csv".equals(extension)) {
            text = readPlainText(context, uri);
        } else if ("docx".equals(extension)) {
            text = readDocx(context, uri);
        } else if ("pdf".equals(extension)) {
            text = readPdf(context, uri);
            scannedPdf = text.trim().isEmpty();
        } else {
            throw new UnsupportedDocumentException("目前只支援 txt、csv、docx 與可選取文字的 pdf。");
        }

        return new DocumentText(displayName, extension, text, scannedPdf);
    }

    private String readPlainText(Context context, Uri uri) throws IOException {
        StringBuilder builder = new StringBuilder();
        try (InputStream input = context.getContentResolver().openInputStream(uri);
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line).append('\n');
            }
        }
        return builder.toString();
    }

    private String readDocx(Context context, Uri uri) throws Exception {
        byte[] documentXml = null;
        try (InputStream input = context.getContentResolver().openInputStream(uri);
             ZipInputStream zip = new ZipInputStream(input)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if ("word/document.xml".equals(entry.getName())) {
                    documentXml = readBytes(zip);
                    break;
                }
            }
        }
        if (documentXml == null) {
            throw new UnsupportedDocumentException("無法讀取 Word 文件內容，可能不是有效的 docx。");
        }

        StringBuilder builder = new StringBuilder();
        XmlPullParser parser = XmlPullParserFactory.newInstance().newPullParser();
        parser.setInput(new ByteArrayInputStream(documentXml), "UTF-8");
        int eventType = parser.getEventType();
        while (eventType != XmlPullParser.END_DOCUMENT) {
            if (eventType == XmlPullParser.TEXT) {
                String text = parser.getText();
                if (text != null && !text.trim().isEmpty()) {
                    builder.append(text.trim()).append(' ');
                }
            }
            eventType = parser.next();
        }
        return builder.toString();
    }

    private String readPdf(Context context, Uri uri) throws IOException {
        PDFBoxResourceLoader.init(context);
        try (InputStream input = context.getContentResolver().openInputStream(uri);
             PDDocument document = PDDocument.load(input)) {
            PDFTextStripper stripper = new PDFTextStripper();
            return stripper.getText(document);
        }
    }

    private static byte[] readBytes(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String resolveDisplayName(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
        }
        String fallback = uri.getLastPathSegment();
        return fallback == null ? "imported-file" : fallback;
    }

    private static String resolveExtension(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "";
        return name.substring(dot + 1).toLowerCase(Locale.US);
    }

    public static class DocumentText {
        public final String displayName;
        public final String extension;
        public final String text;
        public final boolean likelyScannedPdf;

        public DocumentText(String displayName, String extension, String text, boolean likelyScannedPdf) {
            this.displayName = displayName;
            this.extension = extension;
            this.text = text == null ? "" : text;
            this.likelyScannedPdf = likelyScannedPdf;
        }
    }

    public static class UnsupportedDocumentException extends Exception {
        public UnsupportedDocumentException(String message) {
            super(message);
        }
    }
}
