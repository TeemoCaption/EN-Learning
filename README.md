# EN-Learning

一個原生 Android 英文學習 App。第一階段先完成單字功能，課程與多益文法教學之後再接上。

## 目前已完成

- 單字搜尋：優先從網路查詢，成功後寫入本機快取。
- 單字資訊：中文短義、音標、詞性、英文釋義、例句、同義字、近義字、資料來源。
- 英文朗讀：單字與例句可用系統文字轉語音朗讀。
- 收藏單字：可加入收藏並調整熟悉度。
- 文件匯入：支援 `txt`、`csv`、`docx`、可選取文字的 `pdf`。
- 待補清單：網路失敗或資料不完整時，先保留單字供之後重查。
- 可愛怪獸風介面：使用生成圖作為設計參考，實作為原生文字、圖示與卡片，避免文字變模糊或看不懂。

## 專案結構

- `app/`：Android App。
- `worker/`：免費部署用的 Cloudflare Worker 後端雛形。
- `design/cute-monster-ui-reference.png`：這次用圖像生成產出的可愛怪獸風介面參考。

## 建置

確認已安裝 Android Studio 與 Android SDK，並在根目錄建立 `local.properties`：

```properties
sdk.dir=C\:/tmp/android-sdk
```

建置測試版：

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME='C:\tmp\android-sdk'
.\gradlew.bat :app:assembleDebug
```

安裝到已啟動的模擬器或手機：

```powershell
$env:ANDROID_HOME='C:\tmp\android-sdk'
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

如果模擬器黑畫面，可用關閉 Vulkan 的方式啟動：

```powershell
C:\tmp\android-sdk\emulator\emulator.exe -avd ENLearning_API34 -wipe-data -no-snapshot-load -no-snapshot-save -no-boot-anim -no-audio -gpu angle_indirect -feature -Vulkan
```

## 後端

`worker/` 內有 Cloudflare Worker 版本的單字查詢服務雛形，可之後部署到免費方案。App 預設直接使用公開來源查詢；若要改接後端，可在 `app/build.gradle` 設定 `WORD_API_BASE_URL`。
