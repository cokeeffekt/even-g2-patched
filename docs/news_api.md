# News feed API contract

When you set `NEWS_URL=…` during the build, the patched app issues the following requests against your server instead of `api2.evenreal.co`. All paths below are appended to whatever base URL you provided.

Everything in this file was extracted from the Blutter-decompiled `libapp.so` (com.even.sg v2.2.2 build 112). Field types come from the actual deserializer (`IsType_*_Stub` calls): `String?`, `bool?`, `num?`, `List?`. **Almost every field is nullable** — sending `null` (or omitting it) works for most fields. Send the documented type when you have data.

No auth headers are added to these specific calls (the AI agent endpoint has its own auth; news does not). HTTPS is assumed.

---

## Response envelope (REQUIRED for every endpoint)

Every Even API response — news included — is wrapped in a common envelope, decoded by `even/common/api/models/ai/common_entity.dart` and logged by the `[API-Auth]` interceptor. **If you return the raw model body at the top level, the app's JSON parser finds nothing under `.data`, the UI shows "no news sources" / "something went wrong", and logcat shows `traceId=null`.**

```json
{
  "code": 0,
  "msg": "Success",
  "data": { /* the model body documented in the per-endpoint sections below */ },
  "traceId": "<a fresh uuid per request>"
}
```

- `code` (int) — success status. **Real Even uses `0` for success**, *not* `200` as a previous version of this doc claimed. The earlier guess was based on HTTP conventions; live captures showed `0`. Pick anything you like since downstream model code reads `.data` regardless, but match the real backend for safety.
- `msg` (string) — human-readable status. Real Even sends `"Success"` (capital S). `"ok"` works in practice but match real for safety.
- `data` — the actual model body. The `"Response body:"` example under each endpoint below documents what goes here.
- `traceId` (string) — anything that's a string; per-request UUID is conventional. The auth interceptor logs it as `traceId=<value>` so you can correlate logs with your server.

The FastAPI stub at the bottom of this file shows the wrapping helper in context.

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

## Verified contract (live capture, 2026-05-31 / 2026-06-02)

Everything below in the per-endpoint sections was derived from `IsType_*_Stub` traces in the Blutter dump. Live capture sessions (logging both directions through `/_capture/jsonl`) corrected several of those inferences. **Treat this section as authoritative when it conflicts with the legacy tables/examples below.**

| topic | what live capture proved |
|---|---|
| envelope `code` | `0` (not `200`) |
| envelope `msg` | `"Success"` (capital S) |
| `news_favorites_settings` HTTP method | **Both GET *and* POST**. The app uses GET to fetch and POST in other flows. Register handlers on both. Without GET, GETs fall through to the catch-all proxy and the app shows the user's real Even account preferences. |
| `news_categories` is called | Yes. The first capture session missed it because that screen wasn't navigated; a later session confirmed `GET /v2/g/news_categories`. |
| `news_favorites_settings.category` | `List[str]` of category *names* (`["Business", "Politics", ...]`) — **not** a list of objects. The Blutter parser for `_$NewsSettingFromJson` reads this key with `TypeArguments: <String>` (libapp `0x1552ca0`). Returning objects here produces `type '_Map<String, dynamic>' is not a subtype of type 'String' in type cast` on the GET response. |
| `news_favorites_settings.categories` | `List[{name, type, noData}]` — this is the object list. `category` and `categories` are different shapes. |
| `news_favorites_settings.source[]` | Full shape `{id: int, display_name: str, name: str, selected: bool, noData: bool}`. |
| `news_favorites_settings.defaultSource[]` | **Minimal** `{id: int, name: str}` — only those two fields. |
| `news_sources.sources[].sources[]` | Inner list elements are also **minimal** `{id: int, name: str}`. |
| all `id` fields | **`int`**, not strings. |
| `selectOnlyLanguage` field | **Does not exist** in real responses — Blutter showed a parser for it but the live envelope omits it. |
| `language` (singular) and `region` | Always **empty lists** in successful responses (not null, not omitted). |
| **article count: `news_list` MUST return ≥ 5 articles per response** | The receiver-side `receiverApplyNewsEvent` calls a no-arg `List` method on the buffered news list and checks `result - 5 ≥ 0` (libapp `0x155428c..0x1554294`: `sub x0, x1, #5; tbnz x0, #0x3f, FAILURE`). With fewer than 5 articles, every fetch triggers `receiverApplyNewsEvent reindex failure` followed by `APP_REQUEST_CLEAR_ALL_DATA(13)` over BLE — the app **actively wipes the glasses news widget** on every periodic fetch. A `_scheduleForceUpdateRetry` is then queued in 3 min and re-runs the same check, also failing. Workaround: pad your response with at least 5 articles. Stable filler entries are fine (yesterday's brief, day-before, etc.). |
| article `uri` stability | Short opaque identifier; real Even sends a 10-digit numeric string. **Must NOT be a URL.** 16-char hex works in practice. **Stability requirement is strict and goes beyond "same uri across requests"**: the uri must be derived from the article's *slot identity*, NOT its content. `sha256(source).hexdigest()[:16]` works for singleton-per-source slots (Calendar summary, latest G2 Briefs, etc.). `sha256(source + title).hexdigest()[:16]` **does not** — when a slot's title/body refreshes (Calendar shows new events; news feed rotates), the uri changes and the app reindexes against the previous uri it had cached, failing. Title/body/dateTimePub may legitimately change between fetches; the uri must not. |
| article `source` | Must exactly match a `name` in the persisted `subscribed source[]` array. Articles with non-subscribed source names get filtered out client-side. |
| article `dateTimePub` | UTC `Z` format (`"2026-05-31T07:48:40Z"`). Real Even uses recent timestamps; older articles may be filtered. |
| settings persistence | Stored on Even's backend tied to the user account — **not** on-device. So your mock must persist saved settings server-side (e.g. JSON file in a Docker volume), otherwise user selections disappear on every fetch. |
| subscription source-of-truth (open) | The app's "subscribed sources" count appears to be driven by an **on-device cache** that does not refresh from server `selected:true` flags after a manual server-side mutation. Setting `source[i].selected=false` on the server out-of-band did not change the count the app displayed, even after the app's next `GET /v2/g/news_favorites_settings`. Safe approach for mocks: keep all three of `source[]` (`selected:true` for every entry the user "has"), `defaultSource[]` (same entries, minimal shape), and the `news_sources` catalog **fully consistent and complete** for whatever sources the user expects. Diverging the three risks ambiguous UI state. |
| catch-all reverse proxy | Required for the patch to be usable. The 24-char base URL we swap covers the **entire** app's API (auth, jarvis, health, evenhub, …), not just news. Without proxying non-news paths back to `https://api2.evenreal.co`, the app can't even log in. |
| upstream rate-limiting | The proxied flow shows ~45% failure rate on non-news endpoints, with parse errors of `type 'String' is not a subtype of type 'Map<String, dynamic>'`. Diagnosis: `api2.evenreal.co` sometimes returns non-JSON (HTML / `404 page not found`) when an endpoint doesn't exist or rate-limits the proxy IP. Acceptable for personal use; would need caching/throttling for shared deployment. |

A fast-track AI prompt that bundles all of this is in the top-level [README](../README.md#optional-point-the-news-feed-at-your-own-server) — the FastAPI stub at the bottom of this file is also kept current with the corrections above.

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

Response body: `NewsListResModel`. Example (note: `uri` is a short opaque slot identifier — `sha256(source).hexdigest()[:16]` is a reliable form for singleton-per-source slots — and the response **must** contain at least 5 articles; see the Verified contract table above):
```json
{
  "articles": [
    {
      "source": "Hacker News",
      "title": "Story headline",
      "uri": "5a6c2e1d7f3b8a9c",
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
import httpx, json, uuid
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

def wrap(data):
    # Every Even response goes through the {code,msg,data,traceId} envelope.
    # Without this, the auth interceptor logs traceId=null and the model
    # parsers find nothing under .data → "no news sources" in the UI.
    return {"code": 0, "msg": "Success", "data": data, "traceId": uuid.uuid4().hex}

import hashlib
from datetime import datetime, timezone

def _utc_z():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def _slot_uri(slot_key):
    # Stable per-slot opaque ID. Must NOT be a URL (reindex fails on long values),
    # and must be derived from a stable per-slot identity — NOT from title or body.
    # If you hash title in, then every time the slot's content refreshes (Calendar
    # ticks over to "0 events today, 2 events this week", etc.), the uri changes
    # and `receiverApplyNewsEvent reindex failure` fires on the next periodic fetch,
    # which causes the app to send APP_REQUEST_CLEAR_ALL_DATA(13) to the glasses
    # and blank the news widget. Use a stable per-slot key (source name alone for
    # singleton-per-source slots; source + slot index for paginated slots).
    return hashlib.sha256(slot_key.encode()).hexdigest()[:16]


# Aim for at least 5 articles per response. The receiver-side `receiverApplyNewsEvent`
# checks `count - 5 >= 0` on the buffered news list (libapp 0x155428c) and fires
# `APP_REQUEST_CLEAR_ALL_DATA(13)` to the glasses when the check fails. If your real
# content yields fewer than 5 slots, pad with stable filler (yesterday's brief,
# day-before, …) — each with its own stable uri.
_SLOTS = [
    ("G2 Briefs",   "g2-briefs:latest"),
    ("G2 Briefs",   "g2-briefs:yesterday"),
    ("G2 Briefs",   "g2-briefs:day-before"),
    ("Calendar",    "calendar:today"),
    ("Calendar",    "calendar:tomorrow"),
]


@app.post("/v2/g/news_list")
async def news_list(body: dict):
    # body = {"languages": [...], "regions": [...], "categories": [...]}
    # Real per-slot content goes here. The (source, slot_key) pair must stay
    # constant across requests — only title/body/dateTimePub may change.
    ts = _utc_z()
    articles = []
    for source, slot_key in _SLOTS:
        articles.append({
            "source":      source,           # MUST match a name in subscribed source[]
            "title":       "Headline for this slot",
            "body":        "Aim for 500-3000 chars here. Real Even articles are full body text "
                           "— short bodies render as broken cards on the glasses.",
            "dateTimePub": ts,
            "uri":         _slot_uri(slot_key),
        })
    return wrap({"articles": articles, "total": len(articles)})


@app.get("/v2/g/news_sources")
async def news_sources():
    # Inner items are MINIMAL — just {id:int, name:str}.
    return wrap({
        "sources": [
            {"letter": "G", "sources": [{"id": 1, "name": "G2 Briefs"}]},
        ]
    })


@app.get("/v2/g/news_categories")
async def news_categories():
    return wrap({"categories": [
        {"name": "Business",   "type": "Business",   "noData": False},
        {"name": "Technology", "type": "Technology", "noData": False},
    ]})


# News favorites settings — accept BOTH GET and POST. The app uses GET to fetch
# and POSTs through other paths; missing GET = falls through to the proxy and
# the user sees their real Even account preferences.
@app.get("/v2/g/news_favorites_settings")
@app.post("/v2/g/news_favorites_settings")
async def news_favorites_settings_any():
    return wrap(_load_settings())


@app.post("/v2/g/news_favorites_settings_save")
async def save_settings(request: Request):
    body = await request.json()
    return wrap(_save_settings(body))


# Persist user selections to disk so they survive container restarts. Without
# this, every fetch returns _default_setting() and user-chosen sources disappear.
import threading
from pathlib import Path
_SETTINGS_PATH = Path("/data/news_settings.json")
_settings_lock = threading.Lock()

def _default_setting():
    # Verified shape, 2026-05-31 live capture.
    return {
        "language":  [],                # always empty list
        "languages": [
            {"id": 1, "display_name": "English", "name": "EN",
             "selected": True, "noData": False},
        ],
        "region":         [],           # always empty list
        "isAllCategory":  True,
        "category": ["Business", "Technology"],   # List[str] of category NAMES
        "source": [                     # FULL NewsSource shape
            {"id": 1, "display_name": "G2 Briefs",
             "name": "G2 Briefs", "selected": True, "noData": False},
        ],
        "recommended": False,
        "defaultSource": [              # MINIMAL — just id + name
            {"id": 1, "name": "G2 Briefs"},
        ],
        "categories": [                 # objects, NOT plain strings
            {"name": "Business",   "type": "Business",   "noData": False},
            {"name": "Technology", "type": "Technology", "noData": False},
        ],
        "timeRange": 2,
        # NOTE: no `selectOnlyLanguage` field — real Even omits it
    }

def _load_settings_unlocked():
    if _SETTINGS_PATH.exists():
        try:
            return json.loads(_SETTINGS_PATH.read_text())
        except Exception:
            pass
    return _default_setting()

def _load_settings():
    with _settings_lock:
        return _load_settings_unlocked()

def _save_settings(payload: dict):
    with _settings_lock:
        current = _load_settings_unlocked()
        if isinstance(payload, dict):
            merged = {**current, **{k: v for k, v in payload.items()
                                    if k in _default_setting()}}
        else:
            merged = current
        _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _SETTINGS_PATH.write_text(json.dumps(merged, indent=2))
        return merged


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
