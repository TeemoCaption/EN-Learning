# EN-Learning Worker

這個目錄是英文學習安卓應用程式的輕量後端，目標是替安卓端提供統一的單字查詢格式，並集中處理外部字典服務、快取與之後的 ECDICT 中文資料。

## 功能

- `GET /word?term=expand`：查詢單字。
- `POST /batch-words`：批次查詢單字，給文件匯入後補資料使用。
- 整合 Free Dictionary API，補英文定義、例句、音標與部分同義字資料。
- 整合 Datamuse API，補同義字、近義字與相關字。
- 預留 D1 的 `ecdict_words` 表，之後可匯入 ECDICT，提供中文意思與音標備援。
- 查不到中文意思時，仍回傳英文定義，並把 `translation` 標記在 `missing` 內，讓安卓端顯示「待補」狀態。

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
    "examples": [],
    "synonyms": [],
    "nearSynonyms": [],
    "source": {
      "translation": "pending",
      "definition": "free_dictionary",
      "synonyms": "datamuse",
      "nearSynonyms": "datamuse"
    }
  }
}
```

`status` 說明：

- `complete`：中文意思、音標、定義、例句、同義字與近義字都有資料。
- `partial`：至少有部分可用資料，但仍有缺漏欄位。
- `pending`：目前沒有可顯示的意思或定義，安卓端可加入待補資料。
- `invalid`：輸入不是有效英文單字。

## 本機開發

第一次使用：

```powershell
cd worker
npm install
npx wrangler d1 create en_learning_dictionary
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
npx wrangler d1 create en_learning_dictionary
```

把回傳的 `database_id` 填入 `wrangler.toml`。

建立遠端資料表：

```powershell
npm run d1:migrate:remote
```

部署：

```powershell
npm run deploy
```

部署後測試：

```powershell
Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/health"
Invoke-RestMethod "https://en-learning-dictionary.<你的帳號>.workers.dev/word?term=expand"
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
- 文件匯入後：安卓端先抽出英文單字並去重，再每批最多 50 個送到 `POST /batch-words`。
- 安卓端不要上傳原始文件，只上傳單字清單。
- 若 `status` 是 `partial` 或 `pending`，仍可加入單字本，並在待補資料頁提供重新查詢。
