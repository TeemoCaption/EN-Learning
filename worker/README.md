# EN-Learning Worker

這個目錄是英文學習安卓應用程式的輕量後端，目標是替安卓端提供統一的單字查詢格式，並集中處理外部字典服務、快取與之後的 ECDICT 中文資料。

## 功能

- `GET /word?term=expand`：查詢單字。
- `GET /translation-usage`：查看本月 Google 翻譯字元用量。
- `POST /batch-words`：批次查詢單字，給文件匯入後補資料使用。
- `POST /auth/register`：會員註冊，使用信箱與密碼。
- `POST /auth/login`：會員登入，回傳會員令牌。
- `POST /auth/member`：同一個按鈕完成登入；信箱不存在時自動註冊。
- `POST /auth/firebase`：接收 Firebase ID token，驗證成功後建立 Cloudflare Worker 會員令牌。
- 舊版 `/auth/email/*` 與 `/auth/password-reset/*` 仍保留相容，但 Android App 目前改用 Firebase 官方驗證信與重設密碼信。
- `GET /book`：讀取登入會員的雲端收藏單字。
- `POST /book`：把單字加入登入會員的雲端收藏。
- `DELETE /book?word=expand`：從登入會員的雲端收藏移除單字。
- `POST /book/familiarity`：更新登入會員收藏單字的熟悉度。
- 整合 Free Dictionary API，補英文定義、例句與音標。
- 整合 Google Cloud Translation API，補中文意思與最多前三句例句中文翻譯。
- 使用 D1 快取 Google 翻譯結果；同一個單字或同一句例句翻譯過後，不會重複呼叫 Google。
- 使用 D1 記錄 Google 翻譯每月字元用量，預設達 450,000 字元就停止呼叫，保留 50,000 字元緩衝。
- 英文例句仍由線上辭典來源提供；Google Cloud Translation API 負責把英文例句翻成繁體中文，不負責產生新的英文例句。
- 預留 D1 的 `ecdict_words` 表，之後可匯入 ECDICT，提供中文意思與音標備援。
- 中文意思主要使用 Google 官方翻譯；若 Google 未設定或已達保護上限，才會使用 ECDICT 作為備援。
- 會員收藏單字存放在 D1 的 `cloud_user_words`；安卓端不再用手機本機資料庫保存收藏快取。
- 信箱驗證與忘記密碼使用 Firebase Authentication，不需要自備網域或 Brevo/Resend 寄信服務。

## 回傳格式

`GET /word?term=expand` 會回傳：

```json
{
  "ok": true,
  "term": "expand",
  "normalizedTerm": "expand",
  "status": "partial",
  "fromCache": false,
  "missing": ["translation"],
  "entry": {
    "word": "expand",
    "canonicalWord": "expand",
    "phonetic": "",
    "translations": [],
    "definitions": [],
    "examples": [
      {
        "text": "The company plans to expand overseas.",
        "translation": "該公司計劃向海外擴張。",
        "source": "free_dictionary",
        "translationSource": "google_cloud_translation"
      }
    ],
    "synonyms": [],
    "nearSynonyms": [],
    "source": {
      "translation": "pending",
      "definition": "free_dictionary",
      "synonyms": "not_supported",
      "nearSynonyms": "not_supported"
    }
  }
}
```

`status` 說明：

- `complete`：中文意思、音標、定義與例句都有資料。
- `partial`：至少有部分可用資料，但仍有缺漏欄位。
- `pending`：目前沒有可顯示的意思或定義，安卓端可加入待補資料。
- `invalid`：輸入不是有效英文單字。

## 本機開發

第一次使用：

```powershell
cd worker
npm install
npx wrangler d1 create en_learning
```

把 Cloudflare 回傳的 `database_id` 填入 `wrangler.toml` 的 `database_id`。

建立本機資料表：

```powershell
npm run d1:migrate:local
```

啟動本機 Worker：

```powershell
npm run dev
```

測試：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health"
Invoke-RestMethod "http://127.0.0.1:8787/translation-usage"
Invoke-RestMethod "http://127.0.0.1:8787/word?term=expand"
Invoke-RestMethod "http://127.0.0.1:8787/batch-words" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"terms":["expand","revenue","companies"]}'
```

## 部署到 Cloudflare

登入 Cloudflare：

```powershell
cd worker
npx wrangler login
```

建立 D1 資料庫：

```powershell
npx wrangler d1 create en_learning
```

把回傳的 `database_id` 填入 `wrangler.toml`。

建立遠端資料表：

```powershell
npm run d1:migrate:remote
```

## Firebase Authentication 設定

1. 到 Firebase Console 建立專案，使用 Spark 方案即可。
2. 在 Firebase 專案中新增 Android 應用程式，套件名稱填 `com.teemocaption.enlearning`。
3. 到 Authentication -> Sign-in method，啟用 Email/Password。
4. 到 Project settings 複製：
   - Project ID：填到 `worker/wrangler.toml` 的 `FIREBASE_PROJECT_ID`。
   - Web API Key：建置 Android App 時用 `FIREBASE_WEB_API_KEY` 帶入。

`worker/wrangler.toml`：

```toml
[vars]
FIREBASE_PROJECT_ID = "你的 Firebase Project ID"
```

本機開發也可以放在未提交的 `worker/.dev.vars`：

```env
FIREBASE_PROJECT_ID=你的 Firebase Project ID
```

設定 Google 翻譯金鑰：

```powershell
npx wrangler secret put GOOGLE_TRANSLATE_API_KEY
```

請在 Google Cloud Console 另外設定 Cloud Translation API 的用量配額與預算警示。Worker 內建的 `GOOGLE_TRANSLATE_MONTHLY_LIMIT=450000` 是第二層保護，會在達到 45 萬字元時停止呼叫 Google；`GOOGLE_TRANSLATE_EXAMPLE_LIMIT=3` 會限制每次單字查詢最多翻譯前三句例句；真正避免扣款仍建議在 Google Cloud 後台把每月配額限制在免費額度內。

舊版自架驗證碼寄信功能仍留在 Worker 中，但 Android App 已不再使用。除非你要回到自架驗證碼流程，否則不需要設定 `BREVO_API_KEY`、`RESEND_API_KEY`、`EMAIL_FROM` 或 `AUTH_CODE_SECRET`。

部署：

```powershell
npm run deploy
```

部署後測試：

```powershell
Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/health"
Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/translation-usage"
Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/word?term=expand"
```

會員 API 範例：

```powershell
$session = Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/auth/firebase" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"idToken":"Firebase 登入後取得的 ID token"}'

$headers = @{ Authorization = "Bearer $($session.token)" }

Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/book" -Headers $headers

Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/book" `
  -Method Post `
  -Headers $headers `
  -ContentType "application/json" `
  -Body '{"word":"expand","sourceType":"manual","sourceName":"手動搜尋"}'
```

## ECDICT 匯入設計

第一版先預留 D1 表：

```sql
ecdict_words(word, phonetic, translation, definition, pos, exchange)
```

之後可將 ECDICT 轉成 CSV，再匯入 D1。只要 `translation` 有值，安卓端就能直接顯示中文意思；沒有中文資料時，Worker 會回傳英文定義並標記 `missing: ["translation"]`。

建議匯入欄位對應：

- `word` -> `word`
- `phonetic` -> `phonetic`
- `translation` -> `translation`
- `definition` -> `definition`
- `pos` -> `pos`
- `exchange` -> `exchange`

## 安卓端串接建議

- 手動搜尋：呼叫 `GET /word?term=...`。
- 使用者按下重新整理：呼叫 `GET /word?term=...&refresh=1`。
- 文件匯入後：安卓端先抽出英文單字並去重，再逐字送到 `POST /book`，由後端補資料並加入會員雲端收藏。
- 安卓端不要上傳原始文件，只上傳單字清單。
- 若 `status` 是 `partial` 或 `pending`，仍可加入會員雲端收藏，並在待補資料頁提供重新查詢。
- 安卓端只保存登入令牌與搜尋紀錄；收藏單字來源以 `GET /book` 的雲端資料為準，不保存手機本機收藏快取。

建置安卓 APP 時可以用環境變數或 Gradle 參數指定 Worker 網址：

```powershell
$env:WORD_API_BASE_URL="https://en-learning-dictionary.<你的帳號>.workers.dev"
$env:FIREBASE_WEB_API_KEY="你的 Firebase Web API Key"
.\.gradle\codex\gradle-8.10.2\bin\gradle.bat :app:assembleDebug --console=plain
```

或：

```powershell
.\.gradle\codex\gradle-8.10.2\bin\gradle.bat :app:assembleDebug --console=plain `
  -PWORD_API_BASE_URL="https://en-learning-dictionary.<你的帳號>.workers.dev" `
  -PFIREBASE_WEB_API_KEY="你的 Firebase Web API Key"
```
