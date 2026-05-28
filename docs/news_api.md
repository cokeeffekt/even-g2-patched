# News feed API contract

When you set `NEWS_URL=…` during the build, the patched app issues these requests against your server instead of `api2.evenreal.co`. Field names were extracted from `libapp.so` (Blutter-decompiled, v2.2.2 build 112). Types in the response are best-guess from how Dart deserializes them — when in doubt, send strings and ints.

All paths are appended to whatever base URL you provided. Standard HTTPS, no auth headers are sent on these specific calls (the agent endpoint has its own auth flow; news does not).

---

## `POST /v2/g/news_list` — fetch the next batch of articles

Called by `DashboardHttpHelper.getNewsList`. This is the only POST in the news set; it carries the user's category / language / region selections so the server returns relevant articles.

Request body (JSON):
```json
{
  "categories": ["technology", "business", "..."],
  "languages":  ["en", "..."],
  "regions":    ["US", "..."]
}
```

Response body (JSON):
```json
{
  "articles": [
    {
      "source":      "Hacker News",
      "title":       "Article headline",
      "uri":         "https://example.com/story",
      "body":        "First paragraph or full body text...",
      "dateTimePub": "2026-05-29T14:00:00Z"
    }
  ],
  "total": 123
}
```

Notes:
- `articles` is a list of `NewsModel`. `total` lets the app paginate / stop polling when satisfied.
- The glasses ultimately render `title` + `body`; keep `body` short (the display is 576×288 / 16-shade greyscale). The app already truncates, but rendering pre-trimmed content is faster.
- `dateTimePub` is parsed as a string; ISO 8601 is safest.

---

## `GET /v2/g/news_sources` — list available news outlets

Called by `DashboardHttpHelper.getNewsSourceList`.

Response body (JSON):
```json
{
  "sources": [
    {
      "letter": "A",
      "sources": [
        { "id": "ap", "name": "Associated Press", "selected": false, "noData": false }
      ]
    },
    {
      "letter": "B",
      "sources": [
        { "id": "bbc", "name": "BBC", "selected": true, "noData": false }
      ]
    }
  ]
}
```

Notes:
- `letter` is the alphabetical grouping header used by the source picker UI (azlist).
- `selected` reflects whether this source is in the user's current subscription set.
- `noData` is a hint that this source currently has nothing fresh.

---

## `GET /v2/g/news_categories` — list selectable categories

Called by `DashboardHttpHelper.getNewsCategoryList`.

Response body (JSON):
```json
{
  "categories": [
    { "type": "technology", "name": "Technology", "selected": true,  "noData": false },
    { "type": "business",   "name": "Business",   "selected": false, "noData": false }
  ]
}
```

Notes:
- `type` is the stable identifier (also what comes back in the `categories` request field on `news_list`).
- `name` is the localized display label.

---

## `GET /v2/g/news_favorites_settings` — fetch saved news settings

Called by `DashboardHttpHelper.getNewsFavoritesSettings`.

Response body (JSON):
```json
{
  "categories":         [ /* NewsCategory[] (same shape as news_categories) */ ],
  "languages":          [ { "id": "en", "name": "English", "selected": true, "noData": false } ],
  "region":             "US",
  "defaultSource":      "bbc",
  "isAllCategory":      false,
  "selectOnlyLanguage": false,
  "recommended":        true,
  "timeRange":          24
}
```

Notes:
- `timeRange` is parsed as an int (hours; the app's lookback window).
- `region` is a single string, not a list, in this response (unlike the `regions` field on the `news_list` request).
- `defaultSource` is a single `NewsSource.id`.

---

## `POST /v2/g/news_favorites_settings_save` — persist settings

Called by `DashboardHttpHelper.saveNewsFavoritesSettings`. The request body has the same shape as the `news_favorites_settings` response (a `NewsSetting` object). Treat this as "upsert this object" and return 200.

---

## Minimal server stub

A no-op stub that keeps the app happy and just returns one fixed article:

```python
# news_stub.py — `pip install fastapi uvicorn[standard]`
from fastapi import FastAPI
app = FastAPI()

EMPTY_SETTING = {
  "categories": [], "languages": [], "region": "US",
  "defaultSource": "", "isAllCategory": True,
  "selectOnlyLanguage": False, "recommended": True, "timeRange": 24,
}

@app.post("/v2/g/news_list")
async def news_list(body: dict):
    return {
        "articles": [{
            "source": "my feed", "title": "Hello from your patched G2",
            "uri": "https://news.example.com", "body": "this is a custom news feed",
            "dateTimePub": "2026-05-29T00:00:00Z",
        }],
        "total": 1,
    }

@app.get("/v2/g/news_sources")
async def news_sources(): return {"sources": []}

@app.get("/v2/g/news_categories")
async def news_categories(): return {"categories": []}

@app.get("/v2/g/news_favorites_settings")
async def get_settings(): return EMPTY_SETTING

@app.post("/v2/g/news_favorites_settings_save")
async def save_settings(body: dict): return {}
```

Behind a reverse proxy (caddy / nginx) terminating TLS on the host that resolves to your patched URL.
