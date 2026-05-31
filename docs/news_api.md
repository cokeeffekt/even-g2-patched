# News feed API contract

When you set `NEWS_URL=…` during the build, the patched app issues the following requests against your server instead of `api2.evenreal.co`. All paths below are appended to whatever base URL you provided.

Everything in this file was extracted from the Blutter-decompiled `libapp.so` (com.even.sg v2.2.2 build 112). Field types come from the actual deserializer (`IsType_*_Stub` calls): `String?`, `bool?`, `num?`, `List?`. **Almost every field is nullable** — sending `null` (or omitting it) works for most fields. Send the documented type when you have data.

No auth headers are added to these specific calls (the AI agent endpoint has its own auth; news does not). HTTPS is assumed.

---

## Conventions

- **`String?`** → JSON string or `null`.
- **`num?`** → JSON number or `null`. Treat as `int` for `total` / `timeRange`.
- **`bool?`** → JSON boolean or `null`.
- **`List?`** → JSON array or `null`. Element type given in parens (e.g. `List<NewsModel>?`).
- **`Map<String, dynamic>`** is what each list element gets cast to before the per-element parser runs — i.e. send objects, not primitives.
- Dates are parsed via `DateTime.tryParse(...)` → ISO 8601 (`2026-05-29T14:00:00Z` style). Bad strings parse to `null`, the app keeps going.

---

## Models

### `NewsModel` (an article)
| field         | type      | notes |
|---------------|-----------|-------|
| `source`      | `String?` | display name of the publication |
| `title`       | `String?` | headline |
| `uri`         | `String?` | canonical article URL |
| `body`        | `String?` | body text (keep short — 576×288, 4-bit greyscale display) |
| `dateTimePub` | `String?` | ISO 8601; parsed with `DateTime.tryParse(...).toLocal()` |

### `NewsListResModel` (response for `news_list`)
| field      | type                | notes |
|------------|---------------------|-------|
| `articles` | `List<NewsModel>?`  | the page of articles |
| `total`    | `num?`              | total available across all pages |

### `NewsSource` (a publication entry)
| field      | type      | notes |
|------------|-----------|-------|
| `id`       | `String?` | stable identifier |
| `name`     | `String?` | display name |
| `selected` | `bool?`   | is this in the user's current subscription |
| `noData`   | `bool?`   | hint that this source has nothing fresh |

### `NewsSourceGroup` (a letter-bucket of sources)
| field     | type                  | notes |
|-----------|-----------------------|-------|
| `letter`  | `String?`             | azlist header, e.g. `"A"` |
| `sources` | `List<NewsSource>?`   | members of this group |

### `NewsSourceResModel` (response for `news_sources`)
| field     | type                       | notes |
|-----------|----------------------------|-------|
| `sources` | `List<NewsSourceGroup>?`   | grouped by leading letter |

### `NewsCategory` (a category entry — note: NO `selected` field)
| field    | type      | notes |
|----------|-----------|-------|
| `type`   | `String?` | stable identifier — same string the app sends back in the `categories` request field for `news_list` |
| `name`   | `String?` | display label |
| `noData` | `bool?`   | hint |

### `NewsLanguage`
| field          | type      | notes |
|----------------|-----------|-------|
| `id`           | `String?` | BCP-47 ish, e.g. `"en"` |
| `name`         | `String?` | English / source name |
| `display_name` | `String?` | localized display (snake_case in JSON) |
| `selected`     | `bool?`   |  |
| `noData`       | `bool?`   |  |

### `NewsCategoryList` (response for `news_categories`)
| field        | type                  | notes |
|--------------|-----------------------|-------|
| `categories` | `List<NewsCategory>`  | **non-nullable** — return `[]` if empty, not `null` |

### `NewsSetting` (response for `news_favorites_settings`, request for `news_favorites_settings_save`)
| field                | type                  | notes |
|----------------------|-----------------------|-------|
| `categories`         | `List<NewsCategory>?` | primary field |
| `category`           | `List<NewsCategory>?` | legacy alias — emit the same value as `categories` |
| `defaultSource`      | `List<NewsSource>?`   | primary field — yes, it's a list, not a single source |
| `source`             | `List<NewsSource>?`   | legacy alias — emit the same value as `defaultSource` |
| `languages`          | `List<NewsLanguage>?` | |
| `region`             | `List?`               | regions the user selected; element type unconstrained — strings are safe |
| `recommended`        | `bool?`               | "show recommended sources" toggle |
| `isAllCategory`      | `bool?`               | "show all categories" toggle |
| `selectOnlyLanguage` | `bool?`               | "filter by language only" toggle |
| `timeRange`          | `num?`                | lookback window (hours) |

> The app emits both `categories`+`category` and `defaultSource`+`source` in its toJson — looks like a backward-compat carryover. Returning both from the server is safest.

---

## Endpoints

### `POST /v2/g/news_list` — fetch the next batch of articles

Request body (sent by `DashboardHttpHelper.getNewsList`, all three are `List<String>`):
```json
{
  "languages":  ["en"],
  "regions":    ["US"],
  "categories": ["technology", "business"]
}
```

Response body: `NewsListResModel`. Example:
```json
{
  "articles": [
    {
      "source": "Hacker News",
      "title": "Story headline",
      "uri": "https://example.com/story",
      "body": "Lead paragraph...",
      "dateTimePub": "2026-05-29T14:00:00Z"
    }
  ],
  "total": 137
}
```

### `GET /v2/g/news_sources` — list available publications

Response body: `NewsSourceResModel`. Example:
```json
{
  "sources": [
    {
      "letter": "A",
      "sources": [
        { "id": "ap",  "name": "Associated Press", "selected": false, "noData": false }
      ]
    },
    {
      "letter": "B",
      "sources": [
        { "id": "bbc", "name": "BBC",               "selected": true,  "noData": false }
      ]
    }
  ]
}
```

### `GET /v2/g/news_categories` — list selectable categories

Response body: `NewsCategoryList`. Note `categories` is non-nullable — return `[]` if you have none.
```json
{
  "categories": [
    { "type": "technology", "name": "Technology", "noData": false },
    { "type": "business",   "name": "Business",   "noData": false }
  ]
}
```

### `GET /v2/g/news_favorites_settings` — fetch saved settings

Response body: `NewsSetting`. Example:
```json
{
  "categories":   [ { "type": "technology", "name": "Technology", "noData": false } ],
  "category":     [ { "type": "technology", "name": "Technology", "noData": false } ],
  "defaultSource":[ { "id": "bbc", "name": "BBC", "selected": true,  "noData": false } ],
  "source":       [ { "id": "bbc", "name": "BBC", "selected": true,  "noData": false } ],
  "languages":    [ { "id": "en",  "name": "English", "display_name": "English", "selected": true, "noData": false } ],
  "region":       ["US"],
  "recommended":        true,
  "isAllCategory":      false,
  "selectOnlyLanguage": false,
  "timeRange":          24
}
```

### `POST /v2/g/news_favorites_settings_save` — persist settings

Request body: same `NewsSetting` shape as the response above. Treat as an upsert. Any `200` response with a JSON body (even `{}`) is accepted; the app reads `response.success` if present (boolean), and otherwise just treats it as ok.

---

## Minimal server stub

`pip install fastapi uvicorn[standard] httpx`, then `uvicorn news_stub:app --port 4242 --ssl-keyfile … --ssl-certfile …`. Put it behind whatever reverse-proxy/TLS arrangement matches your patched URL.

> **You MUST include the catch-all reverse-proxy route at the bottom of the file.** The URL we patch in `libapp.so` is the shared base for the *entire* app's API (auth, user_info, jarvis, health, etc.), not just news. Without proxying the non-news paths back to `https://api2.evenreal.co`, the app can't even log in. See the [README's news-feed section](../README.md#optional-point-the-news-feed-at-your-own-server) for the full explanation and a copy-paste prompt for AI coding tools.

```python
# news_stub.py
import httpx
from fastapi import FastAPI, Request, Response

app = FastAPI()

UPSTREAM = "https://api2.evenreal.co"
_client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
_HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive",
               "te", "trailers", "transfer-encoding", "upgrade",
               "content-encoding"}

EMPTY_SETTING = {
    "categories": [], "category": [],
    "defaultSource": [], "source": [],
    "languages": [], "region": [],
    "recommended": True, "isAllCategory": True,
    "selectOnlyLanguage": False, "timeRange": 24,
}

@app.post("/v2/g/news_list")
async def news_list(body: dict):
    # body = {"languages": [...], "regions": [...], "categories": [...]}
    return {
        "articles": [
            {
                "source":      "my feed",
                "title":       "Hello from your patched G2",
                "uri":         "https://news.example.com",
                "body":        "This is a custom news feed.",
                "dateTimePub": "2026-05-29T00:00:00Z",
            }
        ],
        "total": 1,
    }

@app.get("/v2/g/news_sources")
async def news_sources():
    return {"sources": []}      # empty az-list is fine

@app.get("/v2/g/news_categories")
async def news_categories():
    return {"categories": []}   # MUST be a list, not null

@app.get("/v2/g/news_favorites_settings")
async def get_settings():
    return EMPTY_SETTING

@app.post("/v2/g/news_favorites_settings_save")
async def save_settings(body: dict):
    return {"success": True}


# Catch-all reverse proxy — MUST be registered last so it doesn't shadow the
# news routes above. Every path the app calls that isn't a news endpoint gets
# transparently forwarded to the real Even Realities backend.
@app.api_route("/{path:path}",
               methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
async def proxy(path: str, request: Request):
    fwd_headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in _HOP_BY_HOP and not k.lower().startswith("proxy-")}
    try:
        upstream = await _client.request(
            request.method,
            f"{UPSTREAM}/{path}",
            params=request.url.query,
            content=await request.body(),
            headers=fwd_headers,
        )
    except httpx.TimeoutException:
        return Response(content=b'{"error":"upstream timeout"}', status_code=504,
                        media_type="application/json")
    except httpx.RequestError:
        return Response(content=b'{"error":"upstream unreachable"}', status_code=502,
                        media_type="application/json")
    resp_headers = {k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP}
    return Response(content=upstream.content,
                    status_code=upstream.status_code,
                    headers=resp_headers)
```

---

## How to re-derive for a new app version

If `com.even.sg` ships a new build with shifted offsets:

1. `grep -aob 'api2.evenreal.co' libapp.so` → new file offset.
2. Run [Blutter](https://github.com/worawit/blutter) → `out/asm/dashboard/`.
3. Field names sit in:
   - `dashboard/model/news/news_list_res_model.dart` — `NewsModel`, `NewsListResModel`
   - `dashboard/model/news/news_source_res.dart` — `NewsSource`, `NewsSourceGroup`, `NewsSourceResModel`
   - `dashboard/model/news/news_setting.dart` — `NewsCategory`, `NewsLanguage`, `NewsSetting`, `NewsCategoryList`
4. Types per field appear next to `IsType_*_Stub` calls in each `_$XxxFromJson` function.
5. Endpoint paths and verbs are in `dashboard/net/dashboard_http_helper.dart`.
