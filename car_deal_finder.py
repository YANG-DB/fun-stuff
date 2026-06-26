"""
car_deal_finder.py
==================
Async Playwright scraper for BC used car listings on AutoTrader.ca.
Scores listings against the market (linear regression on year + km),
stores results in SQLite for resumability, and outputs a ranked Markdown report.

Setup:
    pip install playwright
    playwright install chromium

Run:
    python car_deal_finder.py

Edit the SEARCHES list below to change targets. Re-running is safe — the SQLite
store dedupes by URL and re-scores against accumulated history.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import statistics
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from playwright.async_api import Page, async_playwright


def load_env(path: str = ".env") -> None:
    """Tiny .env loader — no python-dotenv dependency."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — edit these
# ─────────────────────────────────────────────────────────────────────────────

SEARCHES: list[dict] = [
    {
        "name": "Mazda CX-5 (learner car)",
        "make": "mazda",
        "model": "cx-5",
        "year_min": 2020,
        "year_max": 2022,
        "price_min": 18_000,
        "price_max": 28_000,
        "km_max": 100_000,
        "must_match": [r"\bAWD\b"],
        "drop_match": [],
    },
    {
        "name": "Toyota RAV4 Hybrid (family car)",
        "make": "toyota",
        "model": "rav4-hybrid",
        "year_min": 2022,
        "year_max": 2024,
        "price_min": 30_000,
        "price_max": 42_000,
        "km_max": 80_000,
        "must_match": [r"\bAWD\b", r"\bHybrid\b"],
        "drop_match": [r"\bPrime\b"],   # exclude PHEV
    },
    {
        # Best fit for: learner driver, town commute, near-zero maintenance,
        # exceptional resale. FWD by default — AWD (E-Four) is rare and
        # priced higher, so we don't require AWD here.
        "name": "Toyota Corolla Hybrid (learner + commuter)",
        "make": "toyota",
        "model": "corolla-hybrid",
        "year_min": 2020,
        "year_max": 2024,
        "price_min": 18_000,
        "price_max": 32_000,
        "km_max": 100_000,
        "must_match": [r"\bHybrid\b"],
        "drop_match": [],
    },
    {
        # Comparison check vs hybrids. Exclude Performance trim (way too
        # punchy for a learner). Excludes Model Y / S / X by URL specificity.
        "name": "Tesla Model 3 (EV comparison)",
        "make": "tesla",
        "model": "model-3",
        "year_min": 2019,
        "year_max": 2023,
        "price_min": 20_000,
        "price_max": 38_000,
        "km_max": 120_000,
        "must_match": [],
        "drop_match": [r"\bPerformance\b"],
    },
    {
        # Direct Corolla Hybrid competitor — often $3-5k cheaper for the
        # same powertrain class, with the best basic warranty in segment.
        "name": "Hyundai Elantra Hybrid (Corolla alternative)",
        "make": "hyundai",
        "model": "elantra-hybrid",
        "year_min": 2021,
        "year_max": 2024,
        "price_min": 20_000,
        "price_max": 32_000,
        "km_max": 100_000,
        "must_match": [r"\bHybrid\b"],
        "drop_match": [],
    },
    {
        # Best-in-class hybrid economy. 5th-gen only (2023+). Excludes
        # Prius Prime PHEV. AWD (E-Four) included on XSE/LE.
        "name": "Toyota Prius (5th gen, learner-friendly)",
        "make": "toyota",
        "model": "prius",
        "year_min": 2023,
        "year_max": 2024,
        "price_min": 28_000,
        "price_max": 42_000,
        "km_max": 80_000,
        "must_match": [],
        "drop_match": [r"\bPrime\b"],
    },
    {
        # Most learner-friendly gas car in segment. Excludes Si performance
        # trim, Type R, and Civic Hybrid (separate search if wanted).
        "name": "Honda Civic (gas, learner pick)",
        "make": "honda",
        "model": "civic",
        "year_min": 2022,
        "year_max": 2024,
        "price_min": 18_000,
        "price_max": 30_000,
        "km_max": 80_000,
        "must_match": [],
        "drop_match": [r"\bSi\b", r"\bType R\b", r"\bHybrid\b"],
    },
    # ── EV searches: 2024+ model year, under $45k, low-km / great-shape ──
    {
        "name": "Tesla Model 3 (2024+ EV)",
        "make": "tesla", "model": "model-3",
        "year_min": 2024, "year_max": 2025,
        "price_min": 25_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [r"\bPerformance\b"],
    },
    {
        "name": "Tesla Model Y (2024+ EV)",
        "make": "tesla", "model": "model-y",
        "year_min": 2024, "year_max": 2025,
        "price_min": 30_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [r"\bPerformance\b"],
    },
    {
        "name": "Hyundai Ioniq 5 (2024+ EV)",
        "make": "hyundai", "model": "ioniq-5",
        "year_min": 2024, "year_max": 2025,
        "price_min": 25_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [],
    },
    {
        "name": "Kia EV6 (2024+ EV)",
        "make": "kia", "model": "ev6",
        "year_min": 2024, "year_max": 2025,
        "price_min": 25_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [r"\bGT\b"],
    },
    {
        "name": "Hyundai Kona Electric (2024+ EV)",
        "make": "hyundai", "model": "kona-electric",
        "year_min": 2024, "year_max": 2025,
        "price_min": 20_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [],
    },
    {
        "name": "Chevy Bolt EUV (2024+ EV)",
        "make": "chevrolet", "model": "bolt-euv",
        "year_min": 2024, "year_max": 2025,
        "price_min": 18_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [],
    },
    {
        "name": "VW ID.4 (2024+ EV)",
        "make": "volkswagen", "model": "id4",
        "year_min": 2024, "year_max": 2025,
        "price_min": 25_000, "price_max": 45_000, "km_max": 50_000,
        "must_match": [], "drop_match": [],
    },
]

LOCATION    = "Vancouver, BC"
PROVINCE    = "British Columbia"
RADIUS_KM   = 100
DB_PATH     = "car_deals.db"
REPORT_PATH = "deals_report.md"
HTML_DIR    = "car-deals"     # output dir for the deployable site
DEALER_CACHE_DAYS = 7         # re-fetch Google data weekly
HEADLESS    = os.environ.get("HEADLESS", "false").lower() in ("true", "1", "yes")
# False locally so you can solve CAPTCHAs by hand. True in CI (set HEADLESS=true).
MAX_PAGES   = 5               # per search
PAGE_SIZE   = 25
PAUSE_MS    = 1500            # be polite

# ─────────────────────────────────────────────────────────────────────────────
# DATA MODEL + STORAGE
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Listing:
    url: str
    source: str
    search_name: str
    title: str
    year: int | None
    price: int | None
    km: int | None
    location: str | None
    scraped_at: str
    deal_score: float | None = None     # negative = below market = good
    seller_id: str | None = None        # AutoTrader's data-customer-id
    seller_name: str | None = None
    is_cpo: int = 0                     # 1 if title/badge says Certified Pre-Owned

def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS listings (
            url         TEXT PRIMARY KEY,
            source      TEXT,
            search_name TEXT,
            title       TEXT,
            year        INTEGER,
            price       INTEGER,
            km          INTEGER,
            location    TEXT,
            scraped_at  TEXT,
            deal_score  REAL
        )
    """)
    # Idempotent schema migrations for fields added later
    existing = {r[1] for r in conn.execute("PRAGMA table_info(listings)").fetchall()}
    for col, ddl in [
        ("seller_id",   "TEXT"),
        ("seller_name", "TEXT"),
        ("is_cpo",      "INTEGER DEFAULT 0"),
    ]:
        if col not in existing:
            conn.execute(f"ALTER TABLE listings ADD COLUMN {col} {ddl}")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS scrape_runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            search_name  TEXT NOT NULL,
            source       TEXT NOT NULL,
            started_at   TEXT NOT NULL,
            finished_at  TEXT NOT NULL,
            status       TEXT NOT NULL,   -- ok | blocked | no_results | error
            listings     INTEGER DEFAULT 0,
            unique_saved INTEGER DEFAULT 0,
            message      TEXT
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS dealers (
            customer_id   TEXT PRIMARY KEY,
            name          TEXT,
            google_match  TEXT,
            google_addr   TEXT,
            rating        REAL,
            review_count  INTEGER,
            brand_match   INTEGER DEFAULT 0,
            inventory     INTEGER DEFAULT 0,
            cpo_count     INTEGER DEFAULT 0,
            grade         TEXT,
            grade_score   INTEGER,
            enriched_at   TEXT
        )
    """)
    conn.commit()
    return conn

def record_run(conn: sqlite3.Connection, search_name: str, source: str,
               started_at: str, status: str, listings: int,
               message: str | None = None) -> None:
    """Record one (search, source) scrape outcome for the Status tab."""
    conn.execute(
        """INSERT INTO scrape_runs
           (search_name, source, started_at, finished_at, status, listings, message)
           VALUES (?,?,?,?,?,?,?)""",
        (search_name, source, started_at,
         datetime.utcnow().isoformat(timespec="seconds"),
         status, listings, message),
    )
    conn.commit()

def save(conn: sqlite3.Connection, l: Listing) -> None:
    conn.execute(
        """INSERT OR REPLACE INTO listings
           (url, source, search_name, title, year, price, km,
            location, scraped_at, deal_score, seller_id, seller_name, is_cpo)
           VALUES
           (:url,:source,:search_name,:title,:year,:price,:km,
            :location,:scraped_at,:deal_score,:seller_id,:seller_name,:is_cpo)""",
        asdict(l),
    )
    conn.commit()

# ─────────────────────────────────────────────────────────────────────────────
# PARSING
# ─────────────────────────────────────────────────────────────────────────────

PRICE_RE = re.compile(r"\$([\d,]+)")
KM_RE    = re.compile(r"([\d,]+)\s*(?:km|kms|kilom)", re.I)
YEAR_RE  = re.compile(r"\b(20\d{2}|19\d{2})\b")

def grab_int(text: str | None, pat: re.Pattern) -> int | None:
    if not text:
        return None
    m = pat.search(text)
    return int(m.group(1).replace(",", "")) if m else None

# ─────────────────────────────────────────────────────────────────────────────
# AUTOTRADER SCRAPER
# ─────────────────────────────────────────────────────────────────────────────

def autotrader_url(cfg: dict, page_num: int) -> str:
    base = f"https://www.autotrader.ca/cars/{cfg['make']}/{cfg['model']}/bc/vancouver/"
    qs = urlencode({
        "rcp":   PAGE_SIZE,
        "rcs":   (page_num - 1) * PAGE_SIZE,
        "srt":   35,                          # sort: relevance
        "prx":   RADIUS_KM,
        "prv":   PROVINCE,
        "loc":   LOCATION,
        "hprc":  "True",
        "wcp":   "True",
        "pRng":  f"{cfg['price_min']},{cfg['price_max']}",
        "yRng":  f"{cfg['year_min']},{cfg['year_max']}",
        "kmRng": f",{cfg['km_max']}",
    })
    return f"{base}?{qs}"

async def detect_blockers(page: Page) -> bool:
    # Only flag a blocker if challenge UI is actually visible (avoids false positives
    # from script bundles that mention "captcha" on normal pages).
    try:
        text = (await page.inner_text("body")).lower()
    except Exception:
        return False
    return any(s in text for s in ("press & hold", "are you a human", "verify you are human", "checking your browser"))

def _to_int(s: str | None) -> int | None:
    if not s:
        return None
    s = s.strip().replace(",", "")
    return int(s) if s.lstrip("-").isdigit() else None

def kijiji_url(cfg: dict, page_num: int) -> str:
    # all-BC, "Cars & Trucks" category (174), location l9007
    slug = f"{cfg['make']}+{cfg['model']}".replace(" ", "-").lower()
    if page_num <= 1:
        return f"https://www.kijiji.ca/b-cars-trucks/british-columbia/{slug}/k0c174l9007?ad=offering"
    return f"https://www.kijiji.ca/b-cars-trucks/british-columbia/page-{page_num}/{slug}/k0c174l9007?ad=offering"

async def scrape_kijiji(page: Page, cfg: dict, conn: sqlite3.Connection) -> tuple[int, str, str | None]:
    """Scrape Kijiji.ca BC listings. Returns (count, status, message)."""
    count = 0
    pages_with_cards = 0
    for n in range(1, MAX_PAGES + 1):
        url = kijiji_url(cfg, n)
        print(f"  kijiji page {n} → {url}")
        await page.goto(url, wait_until="domcontentloaded")
        try:
            await page.wait_for_selector('[data-testid="listing-card"]', timeout=12000)
        except Exception:
            pass
        await page.evaluate("window.scrollBy(0, 2500)")
        await page.wait_for_timeout(1500)

        cards = await page.query_selector_all('[data-testid="listing-card"]')
        if not cards:
            if n == 1:
                # First page empty — could be a block or just no inventory.
                if await detect_blockers(page):
                    return count, "blocked", "Kijiji presented a challenge page on page 1"
                return count, "no_results", "No cards returned on page 1"
            print("  no Kijiji results — stopping pagination")
            break
        pages_with_cards += 1
        print(f"    found {len(cards)} cards on page")

        for card in cards:
            try:
                a_el = await card.query_selector('[data-testid="listing-link"]')
                if not a_el:
                    continue
                href = await a_el.get_attribute("href") or ""
                if not href:
                    continue
                full = href if href.startswith("http") else f"https://www.kijiji.ca{href}"

                title_el = await card.query_selector('[data-testid="listing-title"]')
                title = ((await title_el.inner_text()).strip().replace("\n", " ")
                         if title_el else (await a_el.inner_text()).strip())

                # Kijiji's text search is loose — enforce model-name in title.
                # e.g. "cx-5" search must literally say cx-5/cx5 (not cx-30 or cx-9).
                model_words = re.split(r"[-+\s]+", cfg["model"].strip().lower())
                # must hit each model token in title (e.g. "rav4" + "hybrid")
                for tok in model_words:
                    if tok and not re.search(rf"\b{re.escape(tok)}\b", title, re.I):
                        title = ""
                        break
                if not title:
                    continue

                # Use the whole card text for must_match/drop_match (catches AWD/Hybrid).
                card_text = (await card.inner_text()).replace("\n", " ")
                if any(re.search(p, card_text, re.I) for p in cfg["drop_match"]):
                    continue
                if not all(re.search(p, card_text, re.I) for p in cfg["must_match"]):
                    continue

                # year from title
                ym = YEAR_RE.search(title)
                year = int(ym.group()) if ym else None

                # price
                p_el = await card.query_selector('[data-testid="autos-listing-price"]')
                price = grab_int(await p_el.inner_text() if p_el else None, PRICE_RE)

                # km — anywhere in card text
                km = grab_int(card_text, KM_RE)

                # location
                loc_el = await card.query_selector('[data-testid="listing-location"]')
                location = ((await loc_el.inner_text()).strip()
                            if loc_el else None)

                # apply user's range filters client-side
                if year is not None and not (cfg["year_min"] <= year <= cfg["year_max"]):
                    continue
                if price is not None and not (cfg["price_min"] <= price <= cfg["price_max"]):
                    continue
                if km is not None and km > cfg["km_max"]:
                    continue

                is_cpo = 1 if re.search(r"\bcertified\b", card_text, re.I) else 0

                # Kijiji listing IDs are unique. Source-prefix to avoid AT collision.
                listing_id = await card.get_attribute("data-listingid")
                listing = Listing(
                    url=full,
                    source="kijiji",
                    search_name=cfg["name"],
                    title=title,
                    year=year,
                    price=price,
                    km=km,
                    location=location,
                    scraped_at=datetime.utcnow().isoformat(timespec="seconds"),
                    seller_id=None,           # not exposed on the search-result card
                    seller_name=None,
                    is_cpo=is_cpo,
                )
                save(conn, listing)
                count += 1
            except Exception as e:
                print(f"    parse warn: {e}")

        await page.wait_for_timeout(PAUSE_MS)
    return count, "ok", None

async def scrape_autotrader(page: Page, cfg: dict, conn: sqlite3.Connection) -> tuple[int, str, str | None]:
    count = 0
    for n in range(1, MAX_PAGES + 1):
        url = autotrader_url(cfg, n)
        print(f"  page {n} → {url}")
        await page.goto(url, wait_until="domcontentloaded")
        try:
            await page.wait_for_selector('[data-testid="list-item"]', timeout=12000)
        except Exception:
            pass
        await page.evaluate("window.scrollBy(0, 1500)")
        await page.wait_for_timeout(1500)

        cards = await page.query_selector_all('[data-testid="list-item"]')

        if not cards and await detect_blockers(page):
            if HEADLESS:
                print("  ✗ Challenge page detected (headless mode) — skipping this search.")
                return count, "blocked", "AutoTrader served a challenge page in headless mode"
            print("  ⚠  Challenge page detected. Solve it in the browser — script will auto-continue.")
            waited = 0
            while await detect_blockers(page):
                await page.wait_for_timeout(3000)
                waited += 3
                if waited % 30 == 0:
                    print(f"    …still waiting ({waited}s)")
                if waited >= 600:
                    print("  ✗ Not cleared after 10min — skipping this search.")
                    return count, "blocked", "Challenge not cleared within 10 minutes"
            await page.wait_for_timeout(2000)
            cards = await page.query_selector_all('[data-testid="list-item"]')

        if not cards:
            if n == 1:
                return count, "no_results", "No cards returned on page 1"
            print("  no results — stopping pagination")
            break

        print(f"    found {len(cards)} cards on page")

        for card in cards:
            try:
                # Structured data lives on the article's data-* attributes
                year  = _to_int(await card.get_attribute("data-model-year"))
                price = _to_int(await card.get_attribute("data-price"))
                km    = _to_int(await card.get_attribute("data-mileage"))

                # Title link gives us href + a clean title via aria-label
                title_a = await card.query_selector("a[aria-label]")
                href = (await title_a.get_attribute("href")) if title_a else None
                if not href:
                    any_a = await card.query_selector("a[href]")
                    href = (await any_a.get_attribute("href")) if any_a else None
                if not href:
                    continue
                full = href if href.startswith("http") else f"https://www.autotrader.ca{href}"

                h2 = await card.query_selector("h2")
                title = ((await h2.inner_text()).strip().replace("\n", " ")
                         if h2 else (await title_a.get_attribute("aria-label") or ""))

                # Filter against full visible card text (catches AWD/Hybrid badges
                # that aren't in the title)
                card_text = (await card.inner_text()).replace("\n", " ")
                if any(re.search(p, card_text, re.I) for p in cfg["drop_match"]):
                    continue
                if not all(re.search(p, card_text, re.I) for p in cfg["must_match"]):
                    continue

                loc_el = await card.query_selector('[data-testid="sellerinfo-address"]')
                location = ((await loc_el.inner_text()).strip().replace("\n", " ")
                            if loc_el else None)

                seller_id = await card.get_attribute("data-customer-id")
                name_el = await card.query_selector('[data-testid="sellerinfo-company-name"]')
                seller_name = ((await name_el.inner_text()).strip()
                               if name_el else None)

                # CPO detection — title or full card text mentions "Certified"
                is_cpo = 1 if re.search(r"\bcertified\b", card_text, re.I) else 0

                listing = Listing(
                    url=full,
                    source="autotrader",
                    search_name=cfg["name"],
                    title=title,
                    year=year,
                    price=price,
                    km=km,
                    location=location,
                    scraped_at=datetime.utcnow().isoformat(timespec="seconds"),
                    seller_id=seller_id,
                    seller_name=seller_name,
                    is_cpo=is_cpo,
                )
                save(conn, listing)
                count += 1
            except Exception as e:
                print(f"    parse warn: {e}")

        await page.wait_for_timeout(PAUSE_MS)
    return count, "ok", None

# ─────────────────────────────────────────────────────────────────────────────
# DEAL SCORING (price ~ year + km, linear)
# ─────────────────────────────────────────────────────────────────────────────

def score_search(conn: sqlite3.Connection, search_name: str) -> None:
    rows = conn.execute(
        "SELECT url,year,price,km FROM listings "
        "WHERE search_name=? AND price IS NOT NULL AND km IS NOT NULL AND year IS NOT NULL",
        (search_name,),
    ).fetchall()

    if len(rows) < 4:
        # too few data points — fall back to median
        if not rows:
            return
        med = statistics.median(r[2] for r in rows)
        for url, *_ , price, _ in [(r[0], r[1], r[2], r[3]) for r in rows]:
            conn.execute("UPDATE listings SET deal_score=? WHERE url=?",
                         ((price - med) / med, url))
        conn.commit()
        return

    ys = [r[1] for r in rows]; ks = [r[3] for r in rows]; ps = [r[2] for r in rows]
    my, mk, mp = statistics.mean(ys), statistics.mean(ks), statistics.mean(ps)

    var_y  = sum((y-my)**2 for y in ys)
    var_k  = sum((k-mk)**2 for k in ks)
    cov_yk = sum((y-my)*(k-mk) for y,k in zip(ys,ks))
    cov_yp = sum((y-my)*(p-mp) for y,p in zip(ys,ps))
    cov_kp = sum((k-mk)*(p-mp) for k,p in zip(ks,ps))

    det = var_y*var_k - cov_yk**2
    if det == 0:
        return
    b = (var_k*cov_yp - cov_yk*cov_kp) / det      # year coefficient
    c = (var_y*cov_kp - cov_yk*cov_yp) / det      # km coefficient
    a = mp - b*my - c*mk

    for url, year, price, km in rows:
        expected = a + b*year + c*km
        if expected > 1000:
            score = (price - expected) / expected
            conn.execute("UPDATE listings SET deal_score=? WHERE url=?", (score, url))
    conn.commit()

# ─────────────────────────────────────────────────────────────────────────────
# DEALER ENRICHMENT + GRADE
# ─────────────────────────────────────────────────────────────────────────────

PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText"

def google_text_search(query: str, key: str, attempts: int = 3) -> dict | None:
    """Returns the top matching place, or None if not found / not callable.
    Retries 403s briefly — Google config changes (key restriction, API enablement)
    can take ~30s to propagate, so a transient 403 may succeed on retry."""
    last_err: str | None = None
    for i in range(attempts):
        req = urllib.request.Request(
            PLACES_ENDPOINT, method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": ("places.displayName,places.rating,"
                                     "places.userRatingCount,places.formattedAddress"),
            },
            data=json.dumps({"textQuery": query}).encode(),
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.load(r)
                places = data.get("places") or []
                return places[0] if places else None
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:300]
            last_err = f"HTTP {e.code}: {body[:120]}"
            if e.code in (403, 429, 500, 502, 503) and i < attempts - 1:
                import time as _t; _t.sleep(2 + 3 * i)  # 2s, 5s
                continue
            break
        except Exception as e:
            last_err = str(e)
            if i < attempts - 1:
                import time as _t; _t.sleep(2)
                continue
            break
    if last_err:
        print(f"    Places API gave up after {attempts} attempts — {last_err[:160]}")
    return None

def _make_for_search(search_name: str) -> str | None:
    """Heuristic: guess the make from the search name (first word).
    Tesla already covered."""
    m = re.search(r"\b(toyota|mazda|honda|nissan|hyundai|kia|ford|chevrolet|"
                  r"subaru|bmw|audi|volkswagen|vw|mercedes|tesla|jeep|ram|"
                  r"dodge|gmc|cadillac|lexus|infiniti|acura|porsche|volvo|"
                  r"mitsubishi|lincoln|buick|chrysler|jaguar|land rover)\b",
                  search_name, re.I)
    return m.group(1).lower() if m else None

def compute_grade(rating: float | None, reviews: int | None,
                  brand_match: int, inventory: int, cpo_count: int) -> tuple[int, str]:
    """Composite reliability score → letter grade. See README for rationale."""
    score = 0

    # Reviews quality
    if rating is not None:
        if   rating >= 4.5: score += 30
        elif rating >= 4.0: score += 20
        elif rating >= 3.5: score += 10
        else:               score -= 10
    # Reviews quantity
    rc = reviews or 0
    if   rc >= 500: score += 30
    elif rc >= 200: score += 20
    elif rc >= 50:  score += 10

    # Brand-name dealer (offers CPO + factory warranty channel)
    if brand_match: score += 20

    # Has CPO listings — concrete warranty signal
    if cpo_count >= 1: score += 10

    # Inventory in our search (proxy for size / specialization)
    if   inventory >= 5: score += 10
    elif inventory >= 3: score += 5

    if   score >= 80: return score, "A"
    elif score >= 60: return score, "B"
    elif score >= 40: return score, "C"
    elif score >= 20: return score, "D"
    else:             return score, "F"

def enrich_dealers(conn: sqlite3.Connection) -> None:
    key = os.environ.get("GOOGLE_API_KEY")
    if not key:
        print("⚠  GOOGLE_API_KEY not set — skipping dealer enrichment "
              "(grades will use heuristic only).")

    # Inventory + cpo_count + a representative seller_name + search per dealer
    rows = conn.execute("""
        SELECT seller_id,
               MAX(seller_name) AS seller_name,
               MAX(search_name) AS search_name,
               COUNT(*)         AS inventory,
               SUM(is_cpo)      AS cpo_count
        FROM listings
        WHERE seller_id IS NOT NULL AND seller_name IS NOT NULL
        GROUP BY seller_id
    """).fetchall()

    print(f"\n🏪 Enriching {len(rows)} unique dealer(s)…")
    cutoff = datetime.utcnow() - timedelta(days=DEALER_CACHE_DAYS)

    for seller_id, seller_name, search_name, inventory, cpo_count in rows:
        cached = conn.execute(
            "SELECT enriched_at FROM dealers WHERE customer_id=?", (seller_id,)
        ).fetchone()
        is_fresh = bool(
            cached and cached[0]
            and datetime.fromisoformat(cached[0]) > cutoff
        )

        rating = review_count = google_match = google_addr = None

        if is_fresh:
            row = conn.execute(
                "SELECT google_match, google_addr, rating, review_count "
                "FROM dealers WHERE customer_id=?", (seller_id,)
            ).fetchone()
            google_match, google_addr, rating, review_count = row
            print(f"  · {seller_name} (cached) → ⭐{rating} / {review_count}")
        elif key:
            place = google_text_search(f"{seller_name} BC Canada", key)
            if place:
                google_match  = place.get("displayName", {}).get("text")
                google_addr   = place.get("formattedAddress")
                rating        = place.get("rating")
                review_count  = place.get("userRatingCount")
                print(f"  · {seller_name} → ⭐{rating or '—'} / {review_count or 0} reviews")
            else:
                print(f"  · {seller_name} → no Google match")

        make = _make_for_search(search_name or "")
        brand_match = int(bool(make and seller_name
                               and re.search(rf"\b{re.escape(make)}\b", seller_name, re.I)))
        gscore, grade = compute_grade(rating, review_count, brand_match,
                                      inventory or 0, cpo_count or 0)

        conn.execute("""
            INSERT OR REPLACE INTO dealers
            (customer_id, name, google_match, google_addr, rating, review_count,
             brand_match, inventory, cpo_count, grade, grade_score, enriched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (seller_id, seller_name, google_match, google_addr, rating, review_count,
              brand_match, inventory, cpo_count, grade, gscore,
              datetime.utcnow().isoformat(timespec="seconds")))
    conn.commit()

# ─────────────────────────────────────────────────────────────────────────────
# WARRANTY STATUS (derived from year + km + is_cpo + factory schedules)
# ─────────────────────────────────────────────────────────────────────────────

# (years, km) tuples. Sources: each manufacturer's Canadian basic/powertrain
# new-vehicle warranties + Toyota Certified Used / Mazda Certified Pre-Owned
# program terms. Verify program specifics with the dealer.
WARRANTY_RULES: dict[str, dict[str, tuple[int, int]]] = {
    "toyota": {
        "basic":            (3,  60_000),
        "powertrain":       (5, 100_000),
        "hybrid":           (10, 240_000),     # Canada hybrid components
        "cpo_powertrain":   (7, 160_000),      # Toyota CPO extension
    },
    "mazda": {
        "basic":            (3,  80_000),
        "powertrain":       (5, 100_000),
        "cpo_powertrain":   (7, 140_000),
    },
    "honda":   {"basic": (3,  60_000), "powertrain": (5, 100_000),
                "cpo_powertrain": (7, 100_000)},     # HondaTrue Certified
    "nissan":  {"basic": (3,  60_000), "powertrain": (5, 100_000)},
    "hyundai": {"basic": (5, 100_000), "powertrain": (5, 100_000),
                "hybrid": (10, 200_000)},            # subsequent-owner transferable
    "kia":     {"basic": (5, 100_000), "powertrain": (5, 100_000)},
    # Tesla Model 3/Y: 4yr/80k basic, 8yr/160k battery+drive unit (70% capacity floor)
    "tesla":   {"basic": (4,  80_000), "powertrain": (8, 160_000)},
    # Chevy Bolt EUV: 3yr/60k basic + 5yr/100k powertrain + 8yr/160k EV battery
    "chevrolet": {"basic": (3, 60_000), "powertrain": (5, 100_000), "hybrid": (8, 160_000)},
    # VW ID.4: 4yr/80k basic + 5yr/100k powertrain + 8yr/160k EV battery
    "volkswagen": {"basic": (4, 80_000), "powertrain": (5, 100_000), "hybrid": (8, 160_000)},
}

def warranty_for(year: int | None, km: int | None, search_name: str | None,
                 is_cpo: bool, today_year: int | None = None) -> dict:
    """Return {label, detail, cls} for a listing. Coverage is approximate —
    we use model year as a proxy for in-service date, which is conservative
    (real in-service date is usually a few months after model year start)."""
    if today_year is None:
        today_year = datetime.now().year

    if year is None:
        return {"label": "—", "detail": "Model year not parsed.", "cls": "unknown"}

    make_match = re.search(
        r"\b(toyota|mazda|honda|nissan|hyundai|kia|tesla|chevrolet|chevy|volkswagen|vw)\b",
        search_name or "", re.I,
    )
    make_key = make_match.group(1).lower() if make_match else None
    rules = WARRANTY_RULES.get(make_key)
    if not rules:
        return {"label": "—",
                "detail": "Warranty rules not configured for this make.",
                "cls": "unknown"}

    is_hybrid = bool(re.search(r"\bhybrid\b", search_name or "", re.I))
    km = km or 0
    age = today_year - year

    valid = []   # human-readable lines for tooltip
    flags = set()

    if is_cpo and "cpo_powertrain" in rules:
        c_yr, c_km = rules["cpo_powertrain"]
        if age <= c_yr and km <= c_km:
            valid.append(f"CPO powertrain — through year {year + c_yr} or {c_km:,} km")
            flags.add("cpo")

    if "basic" in rules:
        b_yr, b_km = rules["basic"]
        if age <= b_yr and km <= b_km:
            valid.append(f"Factory bumper-to-bumper ({b_yr} yr / {b_km:,} km)")
            flags.add("basic")

    if "powertrain" in rules:
        p_yr, p_km = rules["powertrain"]
        if age <= p_yr and km <= p_km:
            valid.append(f"Factory powertrain ({p_yr} yr / {p_km:,} km)")
            flags.add("powertrain")

    if is_hybrid and "hybrid" in rules:
        h_yr, h_km = rules["hybrid"]
        if age <= h_yr and km <= h_km:
            valid.append(f"Hybrid components ({h_yr} yr / {h_km:,} km in Canada)")
            flags.add("hybrid")

    if "cpo" in flags:
        label, cls = "CPO", "cpo"
    elif "basic" in flags or "powertrain" in flags:
        label, cls = "Factory", "factory"
    elif "hybrid" in flags:
        label, cls = "Hybrid only", "hybrid"
    elif is_cpo:
        # Has CPO badge but our age/km calc says expired — still notable
        label, cls = "CPO (check)", "cpo"
        valid.append("⚠ CPO listed but age/km exceeds typical program limits — confirm with dealer.")
    else:
        label, cls = "Expired", "expired"
        valid.append("All factory new-vehicle warranties out by age/km. Ask about extended warranty.")

    return {"label": label, "detail": " · ".join(valid), "cls": cls}

# ─────────────────────────────────────────────────────────────────────────────
# REPORT
# ─────────────────────────────────────────────────────────────────────────────

def write_report(conn: sqlite3.Connection, path: str) -> None:
    rows = conn.execute("""
        SELECT search_name, year, title, price, km, location, deal_score, url
        FROM listings
        WHERE deal_score IS NOT NULL
        ORDER BY search_name, deal_score ASC
    """).fetchall()

    grouped: dict[str, list] = {}
    for r in rows:
        grouped.setdefault(r[0], []).append(r)

    out = ["# Used Car Deal Report",
           f"_Generated {datetime.now().isoformat(timespec='seconds')}_",
           "",
           "Deal score = listing price vs predicted price (year + km regression). "
           "Negative = below market.",
           ""]

    for search, items in grouped.items():
        out += [f"## {search}",
                "",
                "| Deal | Year | Title | Price | KM | Location | Link |",
                "|---|---|---|---|---|---|---|"]
        for r in items[:20]:
            search_name, year, title, price, km, loc, score, url = r
            pct  = f"{score*100:+.1f}%"
            flag = "🔥" if score < -0.10 else "✅" if score < -0.03 else "·" if score < 0.05 else "⚠"
            out.append(
                f"| {flag} {pct} | {year or '?'} | {title[:55]} "
                f"| ${price:,} | {km:,} | {loc or ''} | [view]({url}) |"
            )
        out.append("")

    Path(path).write_text("\n".join(out))
    print(f"\n📄 Report written: {path}")

# ─────────────────────────────────────────────────────────────────────────────
# HTML REPORT (deployable to Firebase Hosting)
# ─────────────────────────────────────────────────────────────────────────────

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BC Used Car Deal Finder</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
    min-height: 100vh; padding: 20px; color: #1a1a1a;
  }
  .container {
    max-width: 1400px; margin: 0 auto; background: #fff;
    border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden;
  }
  header {
    background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
    color: #fff; padding: 28px 32px;
  }
  header h1 { font-size: 2em; margin-bottom: 6px; }
  header p  { opacity: 0.85; font-size: 0.95em; }
  .meta { padding: 16px 32px; background: #f5f7fb; color: #555;
          font-size: 0.85em; border-bottom: 1px solid #e5e7eb;
          display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .freshness {
    padding: 16px 32px; display: flex; align-items: center; gap: 14px;
    font-size: 1.05em; font-weight: 500; border-bottom: 1px solid #e5e7eb;
  }
  .freshness .ico { font-size: 1.6em; }
  .freshness .ago { font-weight: 700; font-size: 1.15em; }
  .freshness .full { font-size: 0.85em; opacity: 0.7; margin-left: auto; }
  .freshness.fresh  { background: #dcfce7; color: #14532d; }
  .freshness.recent { background: #dbeafe; color: #1e3a8a; }
  .freshness.stale  { background: #fef3c7; color: #78350f; }
  .freshness.old    { background: #fee2e2; color: #7f1d1d; }
  @media (max-width: 700px) {
    .freshness { padding: 12px 16px; font-size: 0.95em; flex-wrap: wrap; }
    .freshness .full { margin-left: 0; flex-basis: 100%; }
  }
  .tabs {
    display: flex; gap: 4px; padding: 16px 32px 0; background: #fff;
    border-bottom: 2px solid #e5e7eb; flex-wrap: wrap;
  }
  .tab {
    background: #f1f3f7; color: #444; border: none; padding: 10px 18px;
    border-radius: 8px 8px 0 0; cursor: pointer; font-size: 0.95em;
    font-weight: 500; transition: all 0.15s;
  }
  .tab:hover { background: #e5e9f2; }
  .tab.active { background: #2a5298; color: #fff; }
  .panel { padding: 24px 32px; display: none; }
  .panel.active { display: block; }
  .panel h2 { font-size: 1.3em; margin-bottom: 12px; }
  .panel-meta { color: #666; font-size: 0.9em; margin-bottom: 16px; }
  table {
    width: 100%; border-collapse: collapse; font-size: 0.9em;
    background: #fff; border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eef0f3; }
  th {
    background: #f8fafc; font-weight: 600; color: #374151;
    cursor: pointer; user-select: none; position: sticky; top: 0;
  }
  th:hover { background: #eef2f7; }
  tr:hover td { background: #f9fafc; }
  .deal { font-weight: 600; white-space: nowrap; }
  .deal.fire    { color: #c2410c; }
  .deal.good    { color: #15803d; }
  .deal.fair    { color: #525252; }
  .deal.bad     { color: #b91c1c; }
  .grade {
    display: inline-block; min-width: 22px; text-align: center;
    padding: 2px 6px; border-radius: 4px; font-weight: 700;
    font-size: 0.85em; color: #fff;
  }
  .grade.A { background: #15803d; }
  .grade.B { background: #65a30d; }
  .grade.C { background: #ca8a04; }
  .grade.D { background: #ea580c; }
  .grade.F { background: #b91c1c; }
  .grade.U { background: #6b7280; }     /* unknown */
  .dealer-cell { display: flex; flex-direction: column; gap: 2px; min-width: 130px; }
  .dealer-cell .name { font-size: 0.85em; color: #1f2937; line-height: 1.2;
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
  .dealer-cell .meta { font-size: 0.75em; color: #6b7280; }
  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 0.7em; font-weight: 600; margin-left: 4px;
  }
  .badge.cpo { background: #dbeafe; color: #1e40af; }
  .badge.brand { background: #fef3c7; color: #92400e; }
  .badge.src-autotrader { background: #ecfdf5; color: #065f46; }
  .badge.src-kijiji     { background: #fef3c7; color: #78350f; }
  /* Dealer tour panel */
  .tour-controls {
    display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .tour-controls label { display: flex; gap: 6px; align-items: center; font-size: 0.9em; }
  .tour-controls select { padding: 4px 8px; border: 1px solid #c8d2e0; border-radius: 4px; background: #fff; }
  .tour-controls .summary { margin-left: auto; color: #555; font-size: 0.9em; }
  .dealer-card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    margin-bottom: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .dealer-card-header {
    background: #f8fafc; padding: 14px 18px; display: flex; gap: 14px;
    align-items: flex-start; border-bottom: 1px solid #e5e7eb;
  }
  .dealer-card-grade { flex-shrink: 0; }
  .dealer-card-info { flex: 1; min-width: 0; }
  .dealer-card-info h3 {
    font-size: 1.05em; color: #0f2027; margin-bottom: 4px;
    font-weight: 600;
  }
  .dealer-card-meta { font-size: 0.85em; color: #4b5563; margin-bottom: 2px; }
  .dealer-card-addr { font-size: 0.82em; color: #6b7280; }
  .dealer-card-best { font-size: 0.95em; color: #c2410c; font-weight: 600;
                      align-self: center; white-space: nowrap; margin-left: 12px; }
  .dealer-card .listings-table {
    width: 100%; border-collapse: collapse; margin: 0; font-size: 0.85em;
    box-shadow: none; border-radius: 0;
  }
  .dealer-card .listings-table th,
  .dealer-card .listings-table td {
    padding: 6px 12px; border-bottom: 1px solid #f1f3f7;
  }
  .dealer-card .listings-table th {
    background: #fafbfd; font-weight: 600; color: #6b7280;
    font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .dealer-card .listings-table tr:last-child td { border-bottom: none; }
  .dealer-card .listings-table .deal { font-weight: 600; }
  .visit-check {
    display: flex; align-items: center; gap: 6px; margin-left: 10px;
    font-size: 0.85em; color: #2a5298;
  }
  .visit-check input { accent-color: #2a5298; cursor: pointer; }
  @media print {
    .dealer-card:not(.planned) { display: none; }
    .tour-controls { display: none; }
  }
  .warr {
    display: inline-block; padding: 2px 6px; border-radius: 4px;
    font-size: 0.78em; font-weight: 600; white-space: nowrap;
    cursor: help; position: relative;
  }
  .warr.cpo      { background: #fef3c7; color: #78350f; border: 1px solid #fde68a; }
  .warr.factory  { background: #dcfce7; color: #14532d; }
  .warr.hybrid   { background: #cffafe; color: #155e75; }
  .warr.expired  { background: #fee2e2; color: #7f1d1d; }
  .warr.unknown  { background: #f1f5f9; color: #475569; }
  .warr .tip {
    display: none; position: absolute; left: 0; top: 100%;
    margin-top: 6px; background: #1f2937; color: #e5e7eb;
    padding: 8px 12px; border-radius: 6px; font-weight: 400;
    font-size: 0.92em; line-height: 1.4; white-space: normal;
    width: 280px; z-index: 1000; box-shadow: 0 6px 18px rgba(0,0,0,0.25);
  }
  .warr:hover .tip { display: block; }
  /* Match-score matrix */
  .matrix-toggle {
    background: none; border: 1px solid #c8d2e0; color: #2a5298;
    padding: 4px 12px; border-radius: 6px; cursor: pointer;
    font-size: 0.88em; font-weight: 600;
  }
  .matrix-toggle:hover { background: #eef2f7; }
  .matrix-toggle.on { background: #2a5298; color: #fff; border-color: #2a5298; }
  .matrix-panel {
    background: #f5f7fb; padding: 18px 32px; display: none;
    border-bottom: 1px solid #e5e7eb;
  }
  .matrix-panel.open { display: block; }
  .matrix-panel h3 {
    font-size: 0.95em; color: #1f2937; margin-bottom: 4px;
  }
  .matrix-panel p.hint {
    font-size: 0.82em; color: #6b7280; margin-bottom: 14px;
  }
  .matrix-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 10px 24px; margin-bottom: 12px;
  }
  .matrix-row {
    display: flex; align-items: center; gap: 12px; font-size: 0.9em;
  }
  .matrix-row .lbl { flex: 1; color: #1f2937; }
  .matrix-row input[type=range] { width: 120px; accent-color: #2a5298; }
  .matrix-row .val {
    min-width: 38px; text-align: center; font-weight: 600;
    font-size: 0.85em; color: #2a5298;
    background: #fff; padding: 2px 6px; border-radius: 4px;
    border: 1px solid #e5e7eb;
  }
  .matrix-actions { display: flex; gap: 8px; }
  .matrix-actions button {
    padding: 6px 14px; border-radius: 6px; cursor: pointer;
    font-size: 0.88em; font-weight: 500; border: 1px solid transparent;
  }
  .matrix-actions .apply { background: #2a5298; color: #fff; }
  .matrix-actions .apply:hover { background: #1e3c72; }
  .matrix-actions .preset { background: #fff; color: #2a5298; border-color: #c8d2e0; }
  .matrix-actions .clear  { background: #fff; color: #b91c1c; border-color: #fecaca; }
  .match-bar {
    display: inline-block; min-width: 56px; padding: 3px 9px;
    border-radius: 4px; font-weight: 600; font-size: 0.85em;
    color: #fff; text-align: center;
  }
  .match-bar.high   { background: #15803d; }
  .match-bar.good   { background: #65a30d; }
  .match-bar.med    { background: #ca8a04; }
  .match-bar.low    { background: #ea580c; }
  .match-bar.poor   { background: #b91c1c; }
  th.col-match, td.col-match { display: none; }
  .panel.match-on th.col-match,
  .panel.match-on td.col-match { display: table-cell; }
  /* Status panel */
  .status-summary {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 18px;
  }
  .status-card {
    background: #f5f7fb; padding: 12px 14px; border-radius: 8px;
    border-left: 4px solid #c8d2e0;
  }
  .status-card .num { font-size: 1.5em; font-weight: 700; color: #1f2937; }
  .status-card .lbl { font-size: 0.82em; color: #6b7280; }
  .status-card.ok      { border-left-color: #15803d; }
  .status-card.warn    { border-left-color: #ca8a04; }
  .status-card.err     { border-left-color: #b91c1c; }
  .status-badge {
    display: inline-block; padding: 3px 8px; border-radius: 4px;
    font-size: 0.78em; font-weight: 600; white-space: nowrap;
  }
  .status-badge.ok         { background: #dcfce7; color: #14532d; }
  .status-badge.blocked    { background: #fee2e2; color: #7f1d1d; }
  .status-badge.no_results { background: #f1f5f9; color: #475569; }
  .status-badge.error      { background: #fee2e2; color: #7f1d1d; }
  .status-badge.never      { background: #fef3c7; color: #78350f; }
  .status-msg { font-size: 0.82em; color: #6b7280; max-width: 360px; }
  /* Per-listing notes */
  .note-btn {
    background: none; border: 1px solid #c8d2e0; color: #6b7280;
    padding: 2px 7px; border-radius: 5px; cursor: pointer; font-size: 0.95em;
    margin-left: 6px; vertical-align: middle;
  }
  .note-btn:hover { background: #eef2f7; }
  .note-btn.has-note {
    border-color: #2a5298; color: #2a5298; background: #eff6ff;
    font-weight: 600;
  }
  #note-modal {
    position: fixed; inset: 0; z-index: 5000;
    display: none; align-items: center; justify-content: center; padding: 20px;
  }
  #note-modal.open { display: flex; }
  #note-modal .bg { position: absolute; inset: 0; background: rgba(15, 32, 39, 0.5); }
  #note-modal .content {
    position: relative; background: #fff; border-radius: 12px;
    padding: 24px 28px; width: 100%; max-width: 540px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.3); z-index: 1;
  }
  #note-modal h3 { font-size: 1.05em; color: #0f2027; margin-bottom: 6px; line-height: 1.3; }
  #note-modal .meta-line {
    color: #6b7280; font-size: 0.85em; margin-bottom: 14px;
    padding-bottom: 12px; border-bottom: 1px solid #e5e7eb;
  }
  #note-modal textarea {
    width: 100%; min-height: 160px; padding: 12px;
    border: 1px solid #c8d2e0; border-radius: 8px; font-size: 0.95em;
    font-family: inherit; line-height: 1.5; resize: vertical;
  }
  #note-modal textarea:focus { outline: none; border-color: #2a5298; }
  #note-modal .actions {
    margin-top: 14px; display: flex; gap: 8px; align-items: center;
  }
  #note-modal .actions button {
    padding: 8px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #c8d2e0; background: #fff; font-size: 0.92em;
    font-weight: 500; font-family: inherit;
  }
  #note-modal .actions .save { background: #2a5298; color: #fff; border-color: #2a5298; }
  #note-modal .actions .save:hover { background: #1e3c72; }
  #note-modal .actions .delete { color: #b91c1c; border-color: #fecaca; }
  #note-modal .actions .delete:hover { background: #fee2e2; }
  #note-modal .actions .spacer { flex: 1; }
  .export-btn {
    background: #fff; border: 1px solid #c8d2e0; color: #2a5298;
    padding: 4px 12px; border-radius: 6px; cursor: pointer;
    font-size: 0.88em; font-weight: 600;
  }
  .export-btn:hover:not(:disabled) { background: #eef2f7; }
  .export-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .compare-toggle {
    background: #fff; border: 1px solid #c8d2e0; color: #2a5298;
    padding: 4px 12px; border-radius: 6px; cursor: pointer;
    font-size: 0.88em; font-weight: 600;
  }
  .compare-toggle:hover:not(:disabled) { background: #eef2f7; }
  .compare-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
  .compare-toggle.has-items { background: #fef3c7; color: #78350f; border-color: #fde68a; }
  /* per-row action buttons */
  .ai-btn, .compare-btn {
    background: none; border: 1px solid #c8d2e0; color: #6b7280;
    padding: 2px 7px; border-radius: 5px; cursor: pointer;
    font-size: 0.95em; margin-left: 4px; vertical-align: middle;
    font-family: inherit;
  }
  .ai-btn { color: #7c3aed; border-color: #ddd6fe; }
  .ai-btn:hover { background: #f5f3ff; }
  .compare-btn:hover { background: #eef2f7; }
  .compare-btn.selected {
    background: #fef3c7; color: #78350f; border-color: #fde68a; font-weight: 600;
  }
  .vhr-link {
    display: inline-block; padding: 2px 7px; border-radius: 5px;
    border: 1px solid #fde68a; color: #92400e; background: #fef3c7;
    text-decoration: none; font-size: 0.92em; margin-left: 4px;
    vertical-align: middle; font-weight: 600;
  }
  .vhr-link:hover { background: #fde68a; text-decoration: none; }
  #note-modal .vhr-row {
    display: flex; align-items: center; gap: 8px; margin-top: 12px;
    font-size: 0.88em; color: #4b5563;
  }
  #note-modal .vhr-row input {
    flex: 1; padding: 8px 10px; border: 1px solid #c8d2e0;
    border-radius: 6px; font-size: 0.88em; font-family: inherit;
  }
  #note-modal .vhr-row input:focus { outline: none; border-color: #2a5298; }
  #note-modal .vhr-row label { white-space: nowrap; font-weight: 600; color: #1f2937; }
  /* Report button + modal */
  .report-btn {
    background: none; border: 1px solid #c8d2e0; color: #0f766e;
    padding: 2px 7px; border-radius: 5px; cursor: pointer;
    font-size: 0.95em; margin-left: 4px; vertical-align: middle;
    font-family: inherit;
  }
  .report-btn:hover { background: #ccfbf1; }
  #report-modal {
    position: fixed; inset: 0; z-index: 5500;
    display: none; align-items: center; justify-content: center; padding: 20px;
  }
  #report-modal.open { display: flex; }
  #report-modal .bg { position: absolute; inset: 0; background: rgba(15, 32, 39, 0.55); }
  #report-modal .content {
    position: relative; background: #fff; border-radius: 12px;
    padding: 28px 32px; width: 100%; max-width: 720px;
    max-height: 88vh; overflow: auto;
    box-shadow: 0 24px 60px rgba(0,0,0,0.3); z-index: 1;
  }
  #report-modal h2 { font-size: 1.3em; color: #0f2027; margin-bottom: 4px; }
  #report-modal .sub { color: #6b7280; font-size: 0.9em; margin-bottom: 18px;
                       padding-bottom: 14px; border-bottom: 1px solid #e5e7eb; }
  #report-modal .grid {
    display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px;
    font-size: 0.92em; margin-bottom: 16px;
  }
  #report-modal .grid .k { color: #6b7280; font-weight: 500; }
  #report-modal .grid .v { color: #0f2027; }
  #report-modal h3 {
    font-size: 1em; color: #1f2937; margin: 16px 0 8px;
    padding-bottom: 4px; border-bottom: 1px solid #e5e7eb;
  }
  #report-modal .notes-block {
    background: #f5f7fb; padding: 12px 14px; border-radius: 6px;
    font-size: 0.92em; white-space: pre-wrap; line-height: 1.5; color: #1f2937;
  }
  #report-modal .file-line {
    padding: 4px 0; font-size: 0.88em; color: #1f2937;
    border-bottom: 1px dashed #e5e7eb;
  }
  #report-modal .file-line:last-child { border-bottom: none; }
  #report-modal .actions {
    margin-top: 18px; display: flex; gap: 8px; justify-content: flex-end;
  }
  #report-modal .actions button {
    padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 0.92em;
    border: 1px solid #c8d2e0; background: #fff; font-family: inherit;
  }
  #report-modal .actions .primary { background: #0f766e; color: #fff; border-color: #0f766e; }
  #report-modal .actions .primary:hover { background: #115e59; }
  @media print {
    body * { visibility: hidden; }
    #report-modal, #report-modal * { visibility: visible; }
    #report-modal { position: absolute; inset: 0; padding: 0; }
    #report-modal .bg { display: none; }
    #report-modal .content {
      box-shadow: none; max-height: none; max-width: 100%; padding: 24px;
    }
    #report-modal .actions { display: none; }
  }
  /* Ignore */
  .ignore-btn {
    background: none; border: 1px solid #c8d2e0; color: #6b7280;
    padding: 2px 7px; border-radius: 5px; cursor: pointer;
    font-size: 0.95em; margin-left: 4px; vertical-align: middle;
    font-family: inherit;
  }
  .ignore-btn:hover { background: #f5f7fb; }
  .ignore-btn.ignored {
    background: #fee2e2; color: #7f1d1d; border-color: #fecaca; font-weight: 600;
  }
  tr.row-ignored { opacity: 0.45; }
  tr.row-ignored td { background: #fef2f2 !important; }
  input.cmp-cb {
    width: 18px; height: 18px; vertical-align: middle;
    accent-color: #2a5298; cursor: pointer; margin-left: 4px;
  }
  input.cmp-cb:disabled { opacity: 0.3; cursor: not-allowed; }
  /* Compare panel */
  .compare-table {
    width: 100%; border-collapse: collapse; font-size: 0.88em;
    background: #fff; border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .compare-table th, .compare-table td {
    padding: 8px 12px; border-bottom: 1px solid #f1f3f7;
    vertical-align: top;
  }
  .compare-table tbody tr td:first-child {
    font-weight: 600; color: #4b5563; width: 140px;
    background: #fafbfd; white-space: nowrap;
  }
  .compare-table thead th {
    background: #f5f7fb; font-weight: 600; color: #1f2937;
    border-bottom: 2px solid #e5e7eb;
  }
  .compare-table .car-col { min-width: 200px; }
  .compare-remove {
    background: #fff; border: 1px solid #fecaca; color: #b91c1c;
    padding: 4px 10px; border-radius: 4px; cursor: pointer;
    font-size: 0.82em; font-weight: 500;
  }
  .compare-remove:hover { background: #fee2e2; }
  .compare-actions {
    display: flex; gap: 10px; align-items: center; margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .compare-actions .primary {
    background: #7c3aed; color: #fff; border: 1px solid #7c3aed;
    padding: 8px 16px; border-radius: 6px; cursor: pointer;
    font-size: 0.93em; font-weight: 600;
  }
  .compare-actions .primary:hover { background: #6d28d9; }
  .compare-actions .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .compare-actions .ghost {
    background: #fff; color: #6b7280; border: 1px solid #c8d2e0;
    padding: 8px 14px; border-radius: 6px; cursor: pointer;
    font-size: 0.88em;
  }
  .compare-actions .ghost:hover { background: #f5f7fb; }
  /* Re-scrape button + progress overlay */
  .rescrape-btn {
    background: #fff; border: 1px solid #c8d2e0; color: #2a5298;
    padding: 4px 12px; border-radius: 6px; cursor: pointer;
    font-size: 0.88em; font-weight: 600;
  }
  .rescrape-btn:hover:not(:disabled) { background: #eef2f7; }
  .rescrape-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .rescrape-btn.hidden { display: none; }
  #scrape-overlay {
    position: fixed; inset: 0; z-index: 9000;
    background: rgba(15, 32, 39, 0.55); padding: 30px 20px;
    display: none; align-items: flex-start; justify-content: center; overflow-y: auto;
  }
  #scrape-overlay.open { display: flex; }
  .scrape-modal {
    background: #fff; border-radius: 12px; padding: 24px 28px;
    width: 100%; max-width: 720px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.3);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .scrape-modal h3 { font-size: 1.2em; margin-bottom: 4px; color: #0f2027; }
  .scrape-modal .hint { color: #6b7280; font-size: 0.88em; margin-bottom: 16px; }
  .scrape-bar-wrap {
    height: 10px; background: #eef0f3; border-radius: 5px;
    overflow: hidden; margin-bottom: 8px;
  }
  .scrape-bar-fill {
    height: 100%; background: linear-gradient(90deg, #2a5298, #4caf50);
    width: 0; transition: width 0.4s ease;
  }
  .scrape-summary {
    display: flex; justify-content: space-between; font-size: 0.85em;
    color: #4b5563; margin-bottom: 16px;
  }
  .scrape-steps {
    margin-bottom: 16px; max-height: 320px; overflow-y: auto;
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px;
  }
  .scrape-step {
    display: flex; align-items: center; gap: 10px;
    padding: 5px 8px; font-size: 0.88em; border-radius: 4px;
  }
  .scrape-step.running { background: #eff6ff; }
  .scrape-step.ok      { background: #f0fdf4; }
  .scrape-step.blocked { background: #fef3c7; }
  .scrape-step.error   { background: #fee2e2; }
  .scrape-step .ico { width: 22px; text-align: center; font-size: 1em; }
  .scrape-step .label { flex: 1; color: #1f2937; }
  .scrape-step .count { color: #6b7280; font-size: 0.82em; }
  .scrape-step.pending { opacity: 0.55; }
  .scrape-step.running .ico { animation: scrape-spin 1.2s linear infinite; display: inline-block; }
  @keyframes scrape-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  .scrape-log-wrap {
    margin-bottom: 12px; border: 1px solid #e5e7eb; border-radius: 6px;
    background: #fafbfd;
  }
  .scrape-log-wrap summary {
    padding: 8px 12px; cursor: pointer; color: #4b5563;
    font-size: 0.85em; font-weight: 500;
  }
  .scrape-log-wrap pre {
    margin: 0; padding: 8px 14px 14px; max-height: 200px; overflow: auto;
    font-family: ui-monospace, SF Mono, Menlo, monospace;
    font-size: 0.78em; color: #1f2937; line-height: 1.4;
    background: #fff; border-top: 1px solid #e5e7eb;
    white-space: pre-wrap; word-break: break-all;
  }
  .scrape-actions {
    display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px;
  }
  .scrape-actions button {
    padding: 8px 18px; border-radius: 6px; cursor: pointer;
    font-size: 0.92em; font-weight: 500;
    border: 1px solid #c8d2e0; background: #fff; font-family: inherit;
  }
  .scrape-actions .primary {
    background: #2a5298; color: #fff; border-color: #2a5298;
  }
  .scrape-actions .primary:hover:not(:disabled) { background: #1e3c72; }
  .scrape-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  /* File attachments in note modal */
  .upload-zone {
    margin-top: 14px; padding: 14px; border: 2px dashed #c8d2e0;
    border-radius: 8px; text-align: center; color: #6b7280;
    font-size: 0.85em; cursor: pointer; background: #fafbfd;
  }
  .upload-zone.drag-over { border-color: #2a5298; background: #eff6ff; color: #2a5298; }
  .upload-zone input[type=file] { display: none; }
  .file-list { margin-top: 10px; }
  .file-list:empty { display: none; }
  .file-row {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    background: #f5f7fb; border-radius: 6px; margin-bottom: 4px;
    font-size: 0.85em;
  }
  .file-row .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-row .file-size { color: #6b7280; font-size: 0.78em; white-space: nowrap; }
  .file-row .file-actions { display: flex; gap: 4px; }
  .file-row .file-actions button {
    background: none; border: 1px solid #c8d2e0; padding: 2px 8px;
    border-radius: 4px; cursor: pointer; font-size: 0.85em; font-weight: 500;
    font-family: inherit;
  }
  .file-row .file-actions .dl { color: #2a5298; }
  .file-row .file-actions .dl:hover { background: #eff6ff; }
  .file-row .file-actions .del { color: #b91c1c; border-color: #fecaca; }
  .file-row .file-actions .del:hover { background: #fee2e2; }
  .total-cell {
    white-space: nowrap; position: relative; cursor: help;
    border-bottom: 1px dotted #999; display: inline-block;
  }
  .total-cell .breakdown {
    display: none; position: absolute; left: 0; top: 100%;
    background: #1f2937; color: #fff; padding: 8px 0; border-radius: 6px;
    font-size: 0.78em; white-space: nowrap; z-index: 1000;
    box-shadow: 0 6px 18px rgba(0,0,0,0.25); margin-top: 6px; min-width: 220px;
  }
  .total-cell:hover .breakdown { display: block; }
  .breakdown table { background: transparent; box-shadow: none; }
  .breakdown td {
    padding: 3px 14px; color: #e5e7eb; border: none;
    font-weight: 400; background: transparent;
  }
  .breakdown td.lbl { color: #9ca3af; padding-right: 8px; }
  .breakdown td.amt { text-align: right; font-variant-numeric: tabular-nums; }
  .breakdown tr.total td { color: #fff; font-weight: 600; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.2); }
  .filter-bar {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    background: #f5f7fb; padding: 12px 14px; border-radius: 8px; margin-bottom: 12px;
    font-size: 0.88em;
  }
  .filter-bar label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .filter-bar select, .filter-bar input[type="checkbox"] { cursor: pointer; }
  .filter-bar select {
    padding: 4px 8px; border: 1px solid #c8d2e0; border-radius: 4px;
    background: #fff; font-size: 0.95em;
  }
  .filter-bar .count { margin-left: auto; color: #555; font-weight: 500; }
  .filter-bar .reset {
    background: #fff; border: 1px solid #c8d2e0; color: #2a5298;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em;
  }
  .filter-bar .reset:hover { background: #eef2f7; }
  th.sortable { cursor: pointer; }
  th.sortable:after { content: ' ↕'; opacity: 0.3; font-size: 0.85em; }
  th.sortable.asc:after  { content: ' ↑'; opacity: 1; color: #2a5298; }
  th.sortable.desc:after { content: ' ↓'; opacity: 1; color: #2a5298; }
  .cpo-tooltip { border-bottom: 1px dotted #888; cursor: help; }
  .price { font-weight: 600; }
  td a { color: #2a5298; text-decoration: none; font-weight: 500; }
  td a:hover { text-decoration: underline; }
  .empty { padding: 40px; text-align: center; color: #888; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 0.85em; color: #555; margin-top: 16px; }
  .legend span { padding: 4px 10px; border-radius: 12px; background: #f1f3f7; }
  @media (max-width: 700px) {
    body { padding: 8px; }
    header, .meta, .tabs, .panel { padding-left: 16px; padding-right: 16px; }
    th, td { padding: 8px 6px; font-size: 0.82em; }
    .hide-sm { display: none; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🚗 BC Used Car Deal Finder</h1>
    <p>Listings ranked against a year + km regression. Dealer grade combines Google reviews, brand affiliation, CPO badges, and inventory.</p>
    <p style="margin-top:8px;font-size:0.9em;"><a href="checklist.html" style="color:#9ec5ff;text-decoration:underline;">📋 Pre-purchase checklist →</a></p>
  </header>
  <div class="freshness" id="freshness">
    <span class="ico">📡</span>
    <div>Latest scan: <span class="ago" id="freshness-ago">—</span></div>
    <span class="full" id="freshness-full">—</span>
  </div>
  <div class="meta">
    <span>Total listings: <strong id="total">—</strong></span>
    <span>Dealers: <strong id="dealer-count">—</strong></span>
    <button class="rescrape-btn hidden" id="rescrape-btn" title="Re-run the scraper (requires car_finder_server.py running locally)">🔄 Re-scrape</button>
    <button class="export-btn" id="export-md" disabled>📋 Export notes (0)</button>
    <button class="compare-toggle" id="compare-toggle" disabled>⚖ Compare (0)</button>
    <button class="matrix-toggle" id="matrix-toggle">🎯 Customize match score: OFF</button>
  </div>
  <div class="matrix-panel" id="matrix-panel">
    <h3>What matters most to you?</h3>
    <p class="hint">Set how important each factor is (0 = ignore, 5 = critical). The Match % column ranks listings by your priorities.</p>
    <div class="matrix-grid" id="matrix-grid"></div>
    <div class="matrix-actions">
      <button class="apply"  id="matrix-apply">Apply</button>
      <button class="preset" id="matrix-preset">Use balanced preset</button>
      <button class="clear"  id="matrix-clear">Turn off</button>
    </div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div id="panels"></div>
</div>

<div id="scrape-overlay" role="dialog" aria-modal="true">
  <div class="scrape-modal">
    <h3>🔄 Re-scraping listings…</h3>
    <div class="hint" id="scrape-hint">Chromium will open. Solve any CAPTCHAs if they appear. Page will refresh when done.</div>
    <div class="scrape-bar-wrap"><div class="scrape-bar-fill" id="scrape-bar-fill"></div></div>
    <div class="scrape-summary">
      <span id="scrape-progress-text">starting…</span>
      <span id="scrape-elapsed">0:00</span>
    </div>
    <div class="scrape-steps" id="scrape-steps"></div>
    <details class="scrape-log-wrap">
      <summary>Live log</summary>
      <pre id="scrape-log"></pre>
    </details>
    <div class="scrape-actions">
      <button id="scrape-close" disabled>Close</button>
    </div>
  </div>
</div>

<div id="report-modal" role="dialog" aria-modal="true">
  <div class="bg" data-close></div>
  <div class="content">
    <h2 id="report-title">—</h2>
    <div class="sub" id="report-sub">—</div>
    <div id="report-body"></div>
    <div class="actions">
      <button data-close>Close</button>
      <button class="primary" id="report-print">🖨 Print / Save PDF</button>
    </div>
  </div>
</div>

<div id="note-modal" role="dialog" aria-modal="true">
  <div class="bg" data-close></div>
  <div class="content">
    <h3 id="note-title">—</h3>
    <div class="meta-line" id="note-meta">—</div>
    <textarea id="note-text" placeholder="What I want to remember about this car — CarFax findings, viewing notes, dealer conversations, things to verify, gut feel."></textarea>
    <div class="vhr-row">
      <label for="note-vhr">🔍 CarFax / VHR URL:</label>
      <input type="url" id="note-vhr" placeholder="https://vhr.carfax.ca/?id=…">
    </div>
    <label class="upload-zone" id="upload-zone">
      <input type="file" id="upload-input" multiple>
      📎 Drop files here or click to attach (CarFax PDFs, photos, service invoices, etc.)
    </label>
    <div class="file-list" id="file-list"></div>
    <div class="actions">
      <button class="delete" id="note-delete">Delete note + files</button>
      <span class="spacer"></span>
      <button id="note-cancel" data-close>Cancel</button>
      <button class="save" id="note-save">Save</button>
    </div>
  </div>
</div>

<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
  const payload = JSON.parse(document.getElementById('data').textContent);

  // ── Freshness indicator ───────────────────────────────────────────────
  function relativeAgo(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return { text: 'unknown', hoursAgo: Infinity };
    const ms = Date.now() - t.getTime();
    const s = ms / 1000;
    const m = s / 60;
    const h = m / 60;
    const d = h / 24;
    let text;
    if (s < 90)      text = 'just now';
    else if (m < 60) text = Math.round(m) + ' min ago';
    else if (h < 24) text = Math.round(h) + ' hour' + (Math.round(h) === 1 ? '' : 's') + ' ago';
    else if (d < 7)  text = Math.round(d) + ' day' + (Math.round(d) === 1 ? '' : 's') + ' ago';
    else             text = Math.round(d) + ' days ago';
    return { text, hoursAgo: h };
  }
  function freshnessClass(hoursAgo) {
    if (hoursAgo < 12)  return 'fresh';
    if (hoursAgo < 36)  return 'recent';
    if (hoursAgo < 168) return 'stale';
    return 'old';
  }
  function updateFreshness() {
    const f = document.getElementById('freshness');
    const ago = relativeAgo(payload.generated);
    document.getElementById('freshness-ago').textContent = ago.text;
    document.getElementById('freshness-full').textContent =
      'Scraped at ' + new Date(payload.generated).toLocaleString('en-CA',
        { dateStyle: 'medium', timeStyle: 'short' });
    f.className = 'freshness ' + freshnessClass(ago.hoursAgo);
  }
  updateFreshness();
  setInterval(updateFreshness, 60_000);  // re-tick once a minute

  document.getElementById('total').textContent = payload.total;
  document.getElementById('dealer-count').textContent = (payload.dealers || []).length;

  const tabsEl = document.getElementById('tabs');
  const panelsEl = document.getElementById('panels');

  const esc = s => (s == null ? '' : String(s).replace(/[<>&"]/g,
    c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])));

  const flagFor = (s) => {
    if (s < -0.10) return ['🔥 Hot', 'fire'];
    if (s < -0.03) return ['✅ Good', 'good'];
    if (s <  0.05) return ['· Fair', 'fair'];
    return ['⚠ Above', 'bad'];
  };

  const fmtPct = (s) => (s >= 0 ? '+' : '') + (s * 100).toFixed(1) + '%';
  const fmtMoney = (n) => n == null ? '—' : '$' + n.toLocaleString();
  const fmtKm = (n) => n == null ? '—' : n.toLocaleString() + ' km';

  function gradeBadge(g, score) {
    const cls = (g && /^[A-F]$/.test(g)) ? g : 'U';
    const tip = score != null ? ` title="score ${score}/110"` : '';
    return `<span class="grade ${cls}"${tip}>${esc(g || '?')}</span>`;
  }

  function dealerCell(it) {
    const stars = it.rating != null ? `⭐${it.rating} (${(it.review_count || 0).toLocaleString()})` : 'no Google data';
    const badges = [];
    if (it.brand_match) badges.push('<span class="badge brand" title="Brand-name dealer">brand</span>');
    if (it.is_cpo)      badges.push('<span class="badge cpo" title="Certified Pre-Owned listing">CPO</span>');
    return `
      <div class="dealer-cell">
        <div>${gradeBadge(it.grade, it.grade_score)}
          <span class="name" title="${esc(it.seller_name || '')}">${esc(it.seller_name || '—')}</span>
          ${badges.join('')}
        </div>
        <div class="meta">${stars}</div>
      </div>`;
  }

  const GRADE_RANK = { A:5, B:4, C:3, D:2, F:1 };

  // ── Match-score matrix ────────────────────────────────────────────────
  // Each dimension scores a listing 0-100 on its own axis. The user's slider
  // weight (0-5) determines that axis's contribution to the final match %.
  const MATRIX_DIMS = [
    { key: 'deal',     label: 'Below-market price (deal score)',
      score: it => it.deal_score == null ? null : Math.max(0, Math.min(100, 50 - it.deal_score * 500)) },
    { key: 'mileage',  label: 'Low mileage',
      score: it => it.km == null ? null : Math.max(0, Math.min(100, 100 - (it.km / 1500))) },
    { key: 'year',     label: 'Newer model year',
      score: it => it.year == null ? null : Math.max(0, Math.min(100, (it.year - 2018) * 20)) },
    { key: 'dealer',   label: 'Dealer trustworthiness (Google + brand)',
      score: it => (GRADE_RANK[it.grade] || 0) * 20 },
    { key: 'warranty', label: 'Remaining warranty coverage',
      score: it => (WARR_RANK[it.warranty_cls] || 0) * 25 },
    { key: 'brand',    label: 'Brand-name dealer (Toyota/Mazda dealer for that make)',
      score: it => it.brand_match ? 100 : 0 },
    { key: 'cpo',      label: 'CPO (Certified Pre-Owned) badge',
      score: it => it.is_cpo ? 100 : 0 },
  ];
  const PRESET_BALANCED = { deal: 3, mileage: 2, year: 2, dealer: 3, warranty: 3, brand: 2, cpo: 2 };
  const MATRIX_KEY = 'car-finder-matrix-v1';

  let matrixState = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(MATRIX_KEY) || '{}');
      if (saved && saved.weights) return saved;
    } catch (e) {}
    const zero = {};
    MATRIX_DIMS.forEach(d => zero[d.key] = 0);
    return { active: false, weights: zero };
  })();

  const matrixListeners = [];
  function notifyMatrix() {
    matrixListeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    try { localStorage.setItem(MATRIX_KEY, JSON.stringify(matrixState)); } catch (e) {}
  }

  function matchScore(it) {
    if (!matrixState.active) return null;
    let total = 0, sum = 0;
    for (const d of MATRIX_DIMS) {
      const w = matrixState.weights[d.key] || 0;
      if (w === 0) continue;
      const s = d.score(it);
      if (s == null || isNaN(s)) continue;
      total += w;
      sum += w * Math.max(0, Math.min(100, s));
    }
    if (total === 0) return null;
    return Math.round(sum / total);
  }

  function matchBar(it) {
    const m = matchScore(it);
    if (m == null) return '<span class="match-bar low" title="No score">—</span>';
    let cls = 'poor';
    if (m >= 80) cls = 'high';
    else if (m >= 65) cls = 'good';
    else if (m >= 50) cls = 'med';
    else if (m >= 35) cls = 'low';
    return `<span class="match-bar ${cls}">${m}%</span>`;
  }

  function setupMatrixUI() {
    const grid = document.getElementById('matrix-grid');
    const toggle = document.getElementById('matrix-toggle');
    const panel = document.getElementById('matrix-panel');

    // build sliders
    grid.innerHTML = MATRIX_DIMS.map(d => `
      <div class="matrix-row">
        <span class="lbl">${esc(d.label)}</span>
        <input type="range" min="0" max="5" step="1" data-dim="${d.key}"
               value="${matrixState.weights[d.key] || 0}">
        <span class="val" data-val="${d.key}">${matrixState.weights[d.key] || 0}</span>
      </div>`).join('');

    function updateToggleLabel() {
      toggle.classList.toggle('on', matrixState.active);
      toggle.textContent = matrixState.active
        ? '🎯 Customize match score: ON'
        : '🎯 Customize match score: OFF';
    }
    function syncSlidersToState() {
      MATRIX_DIMS.forEach(d => {
        const v = matrixState.weights[d.key] || 0;
        const sl = grid.querySelector(`input[data-dim="${d.key}"]`);
        const val = grid.querySelector(`.val[data-val="${d.key}"]`);
        if (sl) sl.value = v;
        if (val) val.textContent = v;
      });
    }
    function readSliders() {
      MATRIX_DIMS.forEach(d => {
        const sl = grid.querySelector(`input[data-dim="${d.key}"]`);
        const val = grid.querySelector(`.val[data-val="${d.key}"]`);
        const v = parseInt(sl.value, 10) || 0;
        matrixState.weights[d.key] = v;
        if (val) val.textContent = v;
      });
    }

    grid.addEventListener('input', e => {
      if (e.target.matches('input[type=range]')) {
        readSliders();
        if (matrixState.active) notifyMatrix();
      }
    });

    toggle.addEventListener('click', () => panel.classList.toggle('open'));

    document.getElementById('matrix-apply').addEventListener('click', () => {
      readSliders();
      const anyWeight = MATRIX_DIMS.some(d => (matrixState.weights[d.key] || 0) > 0);
      matrixState.active = anyWeight;
      updateToggleLabel();
      notifyMatrix();
    });
    document.getElementById('matrix-preset').addEventListener('click', () => {
      matrixState.weights = { ...PRESET_BALANCED };
      matrixState.active = true;
      syncSlidersToState();
      updateToggleLabel();
      notifyMatrix();
    });
    document.getElementById('matrix-clear').addEventListener('click', () => {
      MATRIX_DIMS.forEach(d => matrixState.weights[d.key] = 0);
      matrixState.active = false;
      syncSlidersToState();
      updateToggleLabel();
      notifyMatrix();
    });

    updateToggleLabel();
  }
  // ──────────────────────────────────────────────────────────────────────

  // BC: 12% combined tax (5% GST + 7% PST dealer, OR 12% PST private)
  // Doc fee dealer ~$499, ICBC transfer for private ~$80.
  const TAX_RATE = 0.12;
  const DEALER_FEE  = 499;
  const PRIVATE_FEE = 80;

  function feeFor(src) {
    return src === 'kijiji' ? PRIVATE_FEE : DEALER_FEE;
  }
  function totalPrice(it) {
    if (it.price == null) return null;
    return Math.round(it.price * (1 + TAX_RATE) + feeFor(it.source));
  }
  function totalBreakdown(it) {
    if (it.price == null) return '';
    const tax = Math.round(it.price * TAX_RATE);
    const fee = feeFor(it.source);
    const total = it.price + tax + fee;
    const feeLabel = it.source === 'kijiji' ? 'ICBC transfer (private)' : 'Doc fee + admin (dealer)';
    return `<div class="breakdown"><table><tbody>
      <tr><td class="lbl">Sticker price</td><td class="amt">${fmtMoney(it.price)}</td></tr>
      <tr><td class="lbl">Tax (12%)</td>      <td class="amt">+${fmtMoney(tax)}</td></tr>
      <tr><td class="lbl">${feeLabel}</td>    <td class="amt">+${fmtMoney(fee)}</td></tr>
      <tr class="total"><td class="lbl">Out the door</td><td class="amt">${fmtMoney(total)}</td></tr>
    </tbody></table></div>`;
  }

  function sourceBadge(src) {
    const labels = { autotrader: 'AutoTrader', kijiji: 'Kijiji' };
    const label = labels[src] || src || '?';
    return `<span class="badge src-${src || 'unknown'}">${esc(label)}</span>`;
  }

  // ── IndexedDB for file attachments ───────────────────────────────────
  const DB_NAME = 'car-finder-files';
  const DB_VERSION = 1;
  const STORE = 'attachments';
  let _dbPromise = null;
  function db() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('url', 'url', { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }
  async function listAttachments(url) {
    const conn = await db();
    return new Promise(resolve => {
      const out = [];
      const tx = conn.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('url');
      const req = idx.openCursor(IDBKeyRange.only(url));
      req.onsuccess = e => {
        const c = e.target.result;
        if (c) {
          const v = c.value;
          out.push({ id: v.id, name: v.name, type: v.type, size: v.size, added_at: v.added_at });
          c.continue();
        } else resolve(out);
      };
      req.onerror = () => resolve([]);
    });
  }
  async function addAttachment(url, file) {
    const conn = await db();
    const buf = await file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({
        url, name: file.name, type: file.type || 'application/octet-stream',
        size: file.size, data: buf, added_at: new Date().toISOString(),
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function getAttachmentBlob(id) {
    const conn = await db();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return resolve(null);
        resolve({ blob: new Blob([v.data], { type: v.type }), name: v.name });
      };
      req.onerror = () => reject(req.error);
    });
  }
  async function deleteAttachment(id) {
    const conn = await db();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  async function deleteAttachmentsForUrl(url) {
    const list = await listAttachments(url);
    for (const a of list) await deleteAttachment(a.id);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(1) + ' MB';
  }

  // Cache of attachment counts (url → count) for refreshing note buttons w/o async
  const attachCounts = {};
  async function loadAttachCounts() {
    const conn = await db();
    return new Promise(resolve => {
      const tx = conn.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = e => {
        const c = e.target.result;
        if (c) {
          attachCounts[c.value.url] = (attachCounts[c.value.url] || 0) + 1;
          c.continue();
        } else { resolve(); refreshNoteButtons(); updateExportBtn(); }
      };
      req.onerror = () => resolve();
    });
  }

  // ── Per-listing notes ────────────────────────────────────────────────
  const NOTES_KEY = 'car-notes-v1';
  let notes = {};
  try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}') || {}; } catch (e) {}

  function getNote(url) { return notes[url] || ''; }
  function setNote(url, text) {
    if (text && text.trim()) notes[url] = text.trim();
    else delete notes[url];
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (e) {}
    refreshNoteButtons();
    updateExportBtn();
  }

  // ── VHR (CarFax) links per listing ───────────────────────────────────
  const VHR_KEY = 'car-vhr-v1';
  // Pre-seeded mappings — added by user during conversation. Don't override
  // values the user has set themselves.
  const KNOWN_VHRS = {
    'https://www.autotrader.ca/offers/toyota-rav-4-le-awd--clean-title-one-owner-gas-electric-hybrid-white-9f462e84-da22-4f76-876f-ad409410200a':
      'https://vhr.carfax.ca/?id=x08mEg9wpnDYqwr2opZzklEUmH4lrVqX',
    'https://www.autotrader.ca/offers/toyota-rav-4-xle-awd-gas-electric-hybrid-white-f7449ff1-364f-49ed-af7a-10a58a412352':
      'https://vhr.carfax.ca/?id=Qn1m%2FctHiOLm+WlGL8tCMiJU6idTUCcY',
  };
  let vhrLinks = {};
  try { vhrLinks = JSON.parse(localStorage.getItem(VHR_KEY) || '{}') || {}; } catch (e) {}
  let _seeded = false;
  for (const [k, v] of Object.entries(KNOWN_VHRS)) {
    if (!vhrLinks[k]) { vhrLinks[k] = v; _seeded = true; }
  }
  if (_seeded) {
    try { localStorage.setItem(VHR_KEY, JSON.stringify(vhrLinks)); } catch (e) {}
  }
  function getVhr(url) { return vhrLinks[url] || ''; }
  function setVhr(url, vhr) {
    if (vhr && vhr.trim()) vhrLinks[url] = vhr.trim();
    else delete vhrLinks[url];
    try { localStorage.setItem(VHR_KEY, JSON.stringify(vhrLinks)); } catch (e) {}
    refreshVhrLinks();
    refreshNoteButtons();
    updateExportBtn();
  }
  function vhrBtnHtml(url) {
    const v = getVhr(url);
    if (!v) return '';
    return `<a class="vhr-link" href="${esc(v)}" target="_blank" rel="noopener" title="Open CarFax / Vehicle History Report in new tab">🔍 VHR</a>`;
  }
  function vhrSlotHtml(url) {
    return `<span class="vhr-slot" data-vhr-url="${esc(url)}">${vhrBtnHtml(url)}</span>`;
  }
  function refreshVhrLinks() {
    document.querySelectorAll('.vhr-slot').forEach(span => {
      span.innerHTML = vhrBtnHtml(span.dataset.vhrUrl);
    });
  }

  // ── Ignored listings ─────────────────────────────────────────────────
  const IGNORE_KEY = 'car-ignored-v1';
  let ignored = new Set();
  try { ignored = new Set(JSON.parse(localStorage.getItem(IGNORE_KEY) || '[]')); } catch (e) {}
  function isIgnored(url) { return ignored.has(url); }
  function toggleIgnore(url) {
    if (ignored.has(url)) ignored.delete(url); else ignored.add(url);
    try { localStorage.setItem(IGNORE_KEY, JSON.stringify([...ignored])); } catch (e) {}
    refreshIgnoreUi();
    matrixListeners.forEach(fn => { try { fn(); } catch (e) {} });   // re-render panels
  }
  function ignoreBtnHtml(url) {
    const ig = isIgnored(url);
    return `<button class="ignore-btn${ig ? ' ignored' : ''}" data-ignore-url="${esc(url)}" title="${ig ? 'Un-ignore — show normally' : 'Ignore — hide from view'}">${ig ? '🚫' : '👁'}</button>`;
  }
  function refreshIgnoreUi() {
    document.querySelectorAll('button[data-ignore-url]').forEach(btn => {
      const ig = isIgnored(btn.dataset.ignoreUrl);
      btn.classList.toggle('ignored', ig);
      btn.textContent = ig ? '🚫' : '👁';
      btn.title = ig ? 'Un-ignore — show normally' : 'Ignore — hide from view';
    });
  }

  // ── Report button + modal ───────────────────────────────────────────
  function reportBtnHtml(url) {
    return `<button class="report-btn" data-report-url="${esc(url)}" title="Open full single-car report (print-friendly)">📋</button>`;
  }
  function openReportModal(it, searchName) {
    const total = totalPrice(it);
    const dealerStr = it.seller_name
      ? `${it.seller_name} (Grade ${it.grade || '?'}${it.rating != null ? `, ⭐${it.rating}/${(it.review_count||0).toLocaleString()}` : ''})`
      : 'Private / unknown';
    document.getElementById('report-title').textContent = (it.year ?? '?') + ' — ' + it.title;
    document.getElementById('report-sub').innerHTML =
      `${esc(searchName)} · <a href="${esc(it.url)}" target="_blank" rel="noopener">view listing ↗</a>${getVhr(it.url) ? ' · <a href="' + esc(getVhr(it.url)) + '" target="_blank" rel="noopener">CarFax VHR ↗</a>' : ''}`;

    const body = document.getElementById('report-body');
    const noteText = getNote(it.url);
    const m = matchScore(it);
    const ago = relativeAgo(payload.generated).text;
    body.innerHTML = `
      <div class="grid">
        <span class="k">Source</span><span class="v">${esc(it.source || '—')} (scanned ${ago})</span>
        <span class="k">Year</span><span class="v">${it.year ?? '?'}</span>
        <span class="k">Odometer</span><span class="v">${fmtKm(it.km)}</span>
        <span class="k">Sticker price</span><span class="v">${fmtMoney(it.price)}</span>
        <span class="k">Out-the-door (est.)</span><span class="v">${total != null ? fmtMoney(total) : '—'}</span>
        <span class="k">Deal score</span><span class="v">${fmtPct(it.deal_score)} vs market</span>
        <span class="k">Seller</span><span class="v">${esc(dealerStr)}${it.brand_match ? ' · brand dealer' : ''}${it.is_cpo ? ' · CPO' : ''}</span>
        <span class="k">Warranty</span><span class="v">${esc(it.warranty_label)} — ${esc(it.warranty_detail || '')}</span>
        <span class="k">Location</span><span class="v">${esc(it.location || '—')}</span>
        ${m != null ? `<span class="k">Personal match</span><span class="v">${m}% (based on your weights)</span>` : ''}
        ${getVhr(it.url) ? `<span class="k">CarFax VHR</span><span class="v"><a href="${esc(getVhr(it.url))}" target="_blank" rel="noopener">${esc(getVhr(it.url))}</a></span>` : ''}
        ${isIgnored(it.url) ? `<span class="k">Status</span><span class="v">🚫 IGNORED</span>` : ''}
      </div>
      ${noteText ? `<h3>📝 My notes</h3><div class="notes-block">${esc(noteText)}</div>` : ''}
      <div id="report-attachments"></div>`;
    document.getElementById('report-modal').classList.add('open');
    // async-load attachments
    listAttachments(it.url).then(atts => {
      const div = document.getElementById('report-attachments');
      if (!atts || !atts.length) return;
      div.innerHTML = `<h3>📎 Attached documents (${atts.length})</h3>` +
        atts.map(a => `<div class="file-line">• <strong>${esc(a.name)}</strong> <span style="color:#6b7280">(${fmtBytes(a.size)})</span></div>`).join('');
    });
  }
  function closeReportModal() {
    document.getElementById('report-modal').classList.remove('open');
  }
  document.getElementById('report-modal').addEventListener('click', e => {
    if (e.target.matches('[data-close]')) closeReportModal();
  });
  document.getElementById('report-print').addEventListener('click', () => window.print());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('report-modal').classList.contains('open')) {
      closeReportModal();
    }
  });

  // ── Compare cart ─────────────────────────────────────────────────────
  const COMPARE_KEY = 'car-compare-v1';
  const COMPARE_MAX = 5;
  let compareCart = new Set();
  try { compareCart = new Set(JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]')); } catch (e) {}

  function saveCompare() {
    try { localStorage.setItem(COMPARE_KEY, JSON.stringify([...compareCart])); } catch (e) {}
    refreshCompareButtons();
    updateCompareToolbarBtn();
    if (typeof renderComparePanel === 'function') renderComparePanel();
  }
  function updateCompareToolbarBtn() {
    const btn = document.getElementById('compare-toggle');
    if (!btn) return;
    const n = compareCart.size;
    btn.textContent = n > 0 ? `⚖ Compare ${n} car${n > 1 ? 's' : ''}` : '⚖ Compare (0)';
    btn.disabled = n < 1;
    btn.classList.toggle('has-items', n > 0);
  }

  function noteBtnHtml(url) {
    const noteText = getNote(url);
    const fileCount = attachCounts[url] || 0;
    const has = !!noteText || fileCount > 0;
    const tip = has
      ? (noteText ? 'Note: ' + noteText.slice(0, 60) + (noteText.length > 60 ? '…' : '') : '')
        + (fileCount ? ` · ${fileCount} file${fileCount > 1 ? 's' : ''}` : '')
      : 'Add note / attach files';
    const label = has ? (fileCount ? `📝 ${fileCount}` : '📝') : '💬';
    return `<button class="note-btn${has ? ' has-note' : ''}" data-note-url="${esc(url)}" title="${esc(tip.trim())}">${label}</button>`;
  }

  function aiBtnHtml(url) {
    return `<button class="ai-btn" data-ai-url="${esc(url)}" title="Send to AI for verdict (single car)">🤖</button>`;
  }
  function compareBtnHtml(url) {
    const sel = compareCart.has(url);
    const full = !sel && compareCart.size >= 5;
    const title = sel ? 'Remove from Compare tab'
                      : (full ? 'Compare cart full (max 5)' : 'Add to Compare tab');
    return `<input type="checkbox" class="cmp-cb" data-compare-url="${esc(url)}"`
         + (sel ? ' checked' : '')
         + (full ? ' disabled' : '')
         + ` title="${esc(title)}">`;
  }
  function refreshCompareButtons() {
    const full = compareCart.size >= 5;
    document.querySelectorAll('input.cmp-cb[data-compare-url]').forEach(cb => {
      const sel = compareCart.has(cb.dataset.compareUrl);
      cb.checked = sel;
      cb.disabled = !sel && full;
      cb.title = sel ? 'Remove from Compare tab'
                     : (cb.disabled ? 'Compare cart full (max 5)' : 'Add to Compare tab');
    });
  }

  function refreshNoteButtons() {
    document.querySelectorAll('button[data-note-url]').forEach(btn => {
      const url = btn.dataset.noteUrl;
      const noteText = getNote(url);
      const fileCount = attachCounts[url] || 0;
      const has = !!noteText || fileCount > 0;
      btn.classList.toggle('has-note', has);
      btn.textContent = has ? (fileCount ? `📝 ${fileCount}` : '📝') : '💬';
      const tip = has
        ? (noteText ? 'Note: ' + noteText.slice(0, 60) + (noteText.length > 60 ? '…' : '') : '')
          + (fileCount ? ` · ${fileCount} file${fileCount > 1 ? 's' : ''}` : '')
        : 'Add note / attach files';
      btn.title = tip.trim();
    });
  }

  // ── Note modal ───────────────────────────────────────────────────────
  let modalUrl = null;
  async function openNoteModal(it) {
    modalUrl = it.url;
    document.getElementById('note-title').textContent = (it.year ?? '?') + ' ' + it.title;
    const dealerStr = it.seller_name ? it.seller_name + (it.grade ? ' (Grade ' + it.grade + ')' : '') : '—';
    const km = it.km != null ? it.km.toLocaleString() + ' km' : '? km';
    document.getElementById('note-meta').innerHTML =
      `${fmtMoney(it.price)} · ${km} · ${esc(dealerStr)} · <a href="${esc(it.url)}" target="_blank" rel="noopener">view listing ↗</a>`;
    document.getElementById('note-text').value = getNote(it.url);
    document.getElementById('note-modal').classList.add('open');
    setTimeout(() => document.getElementById('note-text').focus(), 50);
    await renderFileList(it.url);
  }
  function closeNoteModal() {
    modalUrl = null;
    document.getElementById('note-modal').classList.remove('open');
    document.getElementById('file-list').innerHTML = '';
    document.getElementById('upload-input').value = '';
  }

  async function renderFileList(url) {
    const list = document.getElementById('file-list');
    const items = await listAttachments(url);
    if (!items.length) { list.innerHTML = ''; return; }
    list.innerHTML = items.map(a => `
      <div class="file-row" data-att-id="${a.id}">
        <span class="file-name" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="file-size">${fmtBytes(a.size)}</span>
        <span class="file-actions">
          <button class="dl" data-att-dl="${a.id}">Download</button>
          <button class="del" data-att-del="${a.id}">Delete</button>
        </span>
      </div>`).join('');
  }

  async function handleFileUpload(files) {
    if (!modalUrl || !files || !files.length) return;
    let added = 0, skipped = [];
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) {
        skipped.push(`${f.name} (>25MB)`);
        continue;
      }
      try {
        await addAttachment(modalUrl, f);
        added++;
        attachCounts[modalUrl] = (attachCounts[modalUrl] || 0) + 1;
      } catch (e) {
        skipped.push(`${f.name} (${e.message || 'error'})`);
      }
    }
    if (skipped.length) alert('Skipped:\\n' + skipped.join('\\n'));
    if (added) {
      await renderFileList(modalUrl);
      refreshNoteButtons();
      updateExportBtn();
    }
  }

  // Wire up upload zone (click + drag-drop) and file list (download/delete)
  const uploadZone = document.getElementById('upload-zone');
  const uploadInput = document.getElementById('upload-input');
  uploadInput.addEventListener('change', () => handleFileUpload(uploadInput.files));
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    handleFileUpload(e.dataTransfer.files);
  });
  document.getElementById('file-list').addEventListener('click', async e => {
    const dl = e.target.closest('button[data-att-dl]');
    const del = e.target.closest('button[data-att-del]');
    if (dl) {
      const id = parseInt(dl.dataset.attDl, 10);
      const got = await getAttachmentBlob(id);
      if (got) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(got.blob);
        a.download = got.name;
        a.click();
      }
    } else if (del) {
      const id = parseInt(del.dataset.attDel, 10);
      if (!confirm('Delete this attachment?')) return;
      await deleteAttachment(id);
      if (attachCounts[modalUrl]) attachCounts[modalUrl]--;
      await renderFileList(modalUrl);
      refreshNoteButtons();
      updateExportBtn();
    }
  });

  document.getElementById('note-modal').addEventListener('click', e => {
    if (e.target.matches('[data-close]')) closeNoteModal();
  });
  document.getElementById('note-save').addEventListener('click', () => {
    if (modalUrl) setNote(modalUrl, document.getElementById('note-text').value);
    closeNoteModal();
  });
  document.getElementById('note-delete').addEventListener('click', async () => {
    if (!modalUrl) return;
    if (!confirm('Delete this note and ALL attached files?')) return;
    setNote(modalUrl, '');
    await deleteAttachmentsForUrl(modalUrl);
    delete attachCounts[modalUrl];
    refreshNoteButtons();
    updateExportBtn();
    closeNoteModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('note-modal').classList.contains('open')) {
      closeNoteModal();
    }
  });

  // Delegated click → open modal when any note button is clicked
  document.addEventListener('click', e => {
    const btn = e.target.closest('button[data-note-url]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const url = btn.dataset.noteUrl;
    // find the item across all searches
    let found = null;
    for (const s of payload.searches) {
      const m = s.items.find(it => it.url === url);
      if (m) { found = m; break; }
    }
    if (found) openNoteModal(found);
  });

  // ── Markdown export ──────────────────────────────────────────────────
  async function exportNotesMarkdown() {
    const all = [];
    payload.searches.forEach(s => s.items.forEach(it => all.push({...it, _search: s.name})));
    const annotated = all.filter(it => !!getNote(it.url) || (attachCounts[it.url] || 0) > 0);
    if (!annotated.length) { alert('No notes or attachments yet.'); return; }

    const lines = [];
    lines.push(`# Car listings — annotated notes`);
    lines.push(``);
    lines.push(`_Exported ${new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}_`);
    lines.push(``);
    lines.push(`Source data scraped ${payload.generated}. Total listings in scrape: ${all.length}. Listings annotated below: ${annotated.length}.`);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    for (const it of annotated) {
      const total = totalPrice(it);
      lines.push(`## ${it.year ?? '?'} — ${it.title}`);
      lines.push(``);
      lines.push(`- **Search bucket:** ${it._search}`);
      lines.push(`- **Source:** ${it.source}`);
      lines.push(`- **Sticker:** ${fmtMoney(it.price)}` + (total ? `  ·  **Out the door:** ${fmtMoney(total)}` : ''));
      lines.push(`- **Odometer:** ${fmtKm(it.km)}`);
      lines.push(`- **Year:** ${it.year ?? '?'}`);
      lines.push(`- **Deal score vs market:** ${fmtPct(it.deal_score)}`);
      const sellerLine = it.seller_name
        ? `${it.seller_name} (Grade ${it.grade || '?'}${it.rating != null ? `, ⭐${it.rating}/${(it.review_count||0).toLocaleString()} Google reviews` : ''}${it.brand_match ? ', brand-name dealer' : ''}${it.is_cpo ? ', CPO listing' : ''})`
        : 'Private / unknown';
      lines.push(`- **Seller:** ${sellerLine}`);
      lines.push(`- **Warranty status:** ${it.warranty_label} — ${it.warranty_detail || ''}`);
      lines.push(`- **Location:** ${it.location || '—'}`);
      lines.push(`- **Listing URL:** ${it.url}`);
      lines.push(``);
      const noteText = getNote(it.url);
      if (noteText) {
        lines.push(`**My note:**`);
        lines.push(``);
        lines.push(noteText.split('\\n').map(l => '> ' + l).join('\\n'));
        lines.push(``);
      }
      const atts = await listAttachments(it.url);
      if (atts.length) {
        lines.push(`**Attached documents** (not in this markdown — upload to the AI separately):`);
        atts.forEach(a => lines.push(`- 📎 \`${a.name}\` (${fmtBytes(a.size)}, ${a.type || 'unknown type'})`));
        lines.push(``);
      }
      lines.push(`---`);
      lines.push(``);
    }
    return lines.join('\\n');
  }

  function updateExportBtn() {
    const btn = document.getElementById('export-md');
    const noteUrls = new Set(Object.keys(notes).filter(u => notes[u] && notes[u].trim()));
    const attachUrls = new Set(Object.keys(attachCounts).filter(u => attachCounts[u] > 0));
    const n = new Set([...noteUrls, ...attachUrls]).size;
    btn.textContent = `📋 Export notes (${n})`;
    btn.disabled = n === 0;
  }
  document.getElementById('export-md').addEventListener('click', async () => {
    const md = await exportNotesMarkdown();
    if (!md) return;
    const annotatedCount = Object.keys(notes).length + Object.keys(attachCounts).length;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(md).then(
        () => alert(`Copied annotated listings as Markdown to your clipboard.\n\nPaste into your AI chat for cross-listing analysis. Any attached documents are listed by filename — open the note again to download them and upload to the AI separately.`),
        () => downloadMarkdown(md)
      );
    } else {
      downloadMarkdown(md);
    }
  });
  function downloadMarkdown(text) {
    const blob = new Blob([text], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `car-notes-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
  }
  updateExportBtn();
  updateCompareToolbarBtn();
  loadAttachCounts();   // async — refreshes note buttons + export count when loaded

  // ── AI single-car + multi-car prompts ────────────────────────────────
  const PRIORITIES_BLOCK = [
    'MY PRIORITIES (in order):',
    '1. Safety',
    '2. Easy for a new / learner driver to learn on',
    '3. Around $35,000 CAD budget (out-the-door)',
    '4. Near-zero maintenance ownership',
    '5. Low town-driving fuel cost',
    '6. Good resale value',
  ].join('\\n');

  function findListingByUrl(url) {
    for (const s of payload.searches) {
      const m = s.items.find(it => it.url === url);
      if (m) return { it: m, search: s.name };
    }
    return null;
  }

  async function buildListingBlock(it, search) {
    const total = totalPrice(it);
    const atts = await listAttachments(it.url);
    const note = getNote(it.url);
    const out = [];
    out.push(`### ${it.year ?? '?'} — ${it.title}`);
    out.push(``);
    out.push(`- **Search bucket:** ${search}`);
    out.push(`- **Source:** ${it.source}`);
    out.push(`- **Sticker:** ${fmtMoney(it.price)}` + (total ? `  ·  **Out the door (estimated):** ${fmtMoney(total)}` : ''));
    out.push(`- **Odometer:** ${fmtKm(it.km)}`);
    out.push(`- **Year:** ${it.year ?? '?'}`);
    out.push(`- **Deal score vs market:** ${fmtPct(it.deal_score)}`);
    const seller = it.seller_name
      ? `${it.seller_name} (Grade ${it.grade || '?'}${it.rating != null ? `, ⭐${it.rating}/${(it.review_count||0).toLocaleString()} Google reviews` : ''}${it.brand_match ? ', brand-name dealer' : ''}${it.is_cpo ? ', CPO listing' : ''})`
      : 'Private / unknown';
    out.push(`- **Seller:** ${seller}`);
    out.push(`- **Warranty status:** ${it.warranty_label} — ${it.warranty_detail || ''}`);
    out.push(`- **Location:** ${it.location || '—'}`);
    out.push(`- **Listing URL:** ${it.url}`);
    if (note) {
      out.push(``);
      out.push(`**My notes:**`);
      out.push(``);
      out.push(note.split('\\n').map(l => '> ' + l).join('\\n'));
    }
    if (atts.length) {
      out.push(``);
      out.push(`**Attached documents** (referenced — I will upload separately):`);
      atts.forEach(a => out.push(`- 📎 \`${a.name}\` (${fmtBytes(a.size)}, ${a.type || 'unknown'})`));
    }
    return out.join('\\n');
  }

  async function askAiForOne(url) {
    const found = findListingByUrl(url);
    if (!found) return;
    const block = await buildListingBlock(found.it, found.search);
    const prompt = [
      `I'm evaluating this used car for purchase. Give me a clear verdict (Buy / Negotiate / Walk away) considering my priorities and any red flags you spot.`,
      ``,
      PRIORITIES_BLOCK,
      ``,
      `## The listing`,
      ``,
      block,
      ``,
      `## What I want from you`,
      ``,
      `1. **Verdict:** Buy / Negotiate / Walk away — pick one.`,
      `2. **The strongest single concern** I should verify before purchase.`,
      `3. **Negotiation angle** (price, doc fee, included extras, warranty, recall completion, etc.).`,
      `4. **What questions to ask the dealer** that I haven't already?`,
      ``,
      `Be direct. Don't hedge. If anything in this listing should make me walk away, say so plainly.`,
    ].join('\\n');
    await sendPromptToAi(prompt, '1 car');
  }

  async function compareSelected() {
    if (compareCart.size === 0) return;
    const urls = [...compareCart];
    const blocks = [];
    for (const url of urls) {
      const f = findListingByUrl(url);
      if (!f) continue;
      blocks.push(await buildListingBlock(f.it, f.search));
      blocks.push(``);
      blocks.push(`---`);
      blocks.push(``);
    }
    const n = urls.length;
    const prompt = [
      `I'm comparing ${n} used cars and need to pick one (or walk away from all). Please rank them for my priorities and give me one decisive recommendation.`,
      ``,
      PRIORITIES_BLOCK,
      ``,
      `## The candidates`,
      ``,
      blocks.join('\\n'),
      `## What I want from you`,
      ``,
      `1. **Rank them** from best to worst for my priorities. One short paragraph per car explaining the trade-offs.`,
      `2. **One decisive pick** (or "walk away from all" if appropriate) and why.`,
      `3. **Single biggest risk per car** — what's most likely to bite me later.`,
      `4. **What's missing from my data** — what should I find out before deciding?`,
      ``,
      `Be direct. Don't hedge.`,
    ].join('\\n');
    await sendPromptToAi(prompt, `${n} cars`);
  }

  async function sendPromptToAi(prompt, label) {
    let copied = false;
    try { await navigator.clipboard.writeText(prompt); copied = true; } catch (e) {}
    if (copied) {
      const open = confirm(
        `Prompt for ${label} copied to clipboard (${prompt.length.toLocaleString()} chars).\\n\\n` +
        `Click OK to open Claude.ai in a new tab — then paste (Cmd+V).\\n` +
        `Or click Cancel to keep this tab and paste into your AI of choice.`
      );
      if (open) window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer');
    } else {
      // Fallback: open the prompt in a new tab as readable text for manual copy
      const w = window.open('', '_blank');
      if (w) {
        const safe = prompt.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
        w.document.write(
          `<title>AI prompt — ${label}</title>` +
          `<pre style="white-space:pre-wrap;font-family:ui-monospace,SF Mono,Menlo,monospace;` +
          `padding:24px;max-width:900px;margin:auto;line-height:1.5;font-size:14px">${safe}</pre>`
        );
      }
    }
  }

  // Delegated handlers for AI button (click) + Compare checkbox (change)
  document.addEventListener('click', e => {
    const ai = e.target.closest('button[data-ai-url]');
    if (ai) { e.preventDefault(); e.stopPropagation(); askAiForOne(ai.dataset.aiUrl); }
  });
  document.addEventListener('change', e => {
    const cb = e.target.closest('input.cmp-cb[data-compare-url]');
    if (!cb) return;
    const url = cb.dataset.compareUrl;
    if (cb.checked) {
      if (compareCart.size >= COMPARE_MAX) {
        cb.checked = false;
        alert(`Max ${COMPARE_MAX} cars in compare cart. Remove one first.`);
        return;
      }
      compareCart.add(url);
    } else {
      compareCart.delete(url);
    }
    saveCompare();
  });

  document.getElementById('compare-toggle').addEventListener('click', () => compareSelected());

  function warrantyCell(it) {
    const cls = it.warranty_cls || 'unknown';
    const label = it.warranty_label || '—';
    const detail = it.warranty_detail || '';
    return `<span class="warr ${cls}">${esc(label)}<span class="tip">${esc(detail)}</span></span>`;
  }

  function rowHtml(it) {
    const [label, cls] = flagFor(it.deal_score);
    const total = totalPrice(it);
    const totalCell = total == null
      ? '<span class="total-cell">—</span>'
      : `<span class="total-cell"><strong>${fmtMoney(total)}</strong>${totalBreakdown(it)}</span>`;
    return `<tr>
        <td class="col-match">${matchBar(it)}</td>
        <td class="deal ${cls}">${label} ${fmtPct(it.deal_score)}</td>
        <td>${it.year ?? '?'}</td>
        <td>${esc(it.title)} ${sourceBadge(it.source)}</td>
        <td class="price">${totalCell}</td>
        <td>${fmtKm(it.km)}</td>
        <td>${dealerCell(it)}</td>
        <td>${warrantyCell(it)}</td>
        <td class="hide-sm">${esc(it.location || '')}</td>
        <td><a href="${esc(it.url)}" target="_blank" rel="noopener">view ↗</a> ${noteBtnHtml(it.url)} ${aiBtnHtml(it.url)} ${compareBtnHtml(it.url)}</td>
      </tr>`;
  }

  // Higher = more reassuring warranty status, used for sorting/filtering
  const WARR_RANK = { cpo: 4, factory: 3, hybrid: 2, expired: 1, unknown: 0 };

  function applyFilterSort(items, state) {
    const minRank = GRADE_RANK[state.minGrade] || 0;
    let out = items.filter(it => {
      if (state.source !== 'ALL' && it.source !== state.source) return false;
      if (state.brandOnly && !it.brand_match) return false;
      if (state.cpoOnly   && !it.is_cpo)      return false;
      if (state.minGrade !== 'ALL') {
        const r = GRADE_RANK[it.grade] || 0;
        if (r < minRank) return false;
      }
      if (state.warranty !== 'ALL') {
        if (state.warranty === 'not_expired') {
          if (it.warranty_cls === 'expired' || it.warranty_cls === 'unknown') return false;
        } else if (it.warranty_cls !== state.warranty) {
          return false;
        }
      }
      return true;
    });
    const k = state.sortKey;
    const valueOf = (it) => {
      if (k === 'total_price')  return totalPrice(it);
      if (k === 'grade')        return GRADE_RANK[it.grade] || 0;
      if (k === 'warranty_cls') return WARR_RANK[it.warranty_cls] || 0;
      if (k === 'match')        return matchScore(it);
      return it[k];
    };
    out.sort((a, b) => {
      const av = valueOf(a), bv = valueOf(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * state.sortDir;
      return (av - bv) * state.sortDir;
    });
    return out;
  }

  function buildSearchPanel(search, idx) {
    const panel = document.createElement('div');
    panel.id = 'panel-' + idx;
    panel.className = 'panel' + (idx === 0 ? ' active' : '');
    if (!search.items.length) {
      panel.innerHTML = `<h2>${esc(search.name)}</h2><div class="empty">No scored listings yet.</div>`;
      return panel;
    }

    const state = {
      sortKey: 'deal_score', sortDir: 1,    // ascending = best deal first
      source: 'ALL', brandOnly: false, cpoOnly: false, minGrade: 'ALL',
      warranty: 'ALL',
    };

    panel.innerHTML = `
      <h2>${esc(search.name)}</h2>
      <div class="filter-bar">
        <label>Source
          <select data-fld="source">
            <option value="ALL">All</option>
            <option value="autotrader">AutoTrader</option>
            <option value="kijiji">Kijiji</option>
          </select>
        </label>
        <label>Min dealer grade
          <select data-fld="minGrade">
            <option value="ALL">All</option>
            <option value="A">A only</option>
            <option value="B">A or B</option>
            <option value="C">A–C</option>
            <option value="D">A–D</option>
          </select>
        </label>
        <label>Warranty
          <select data-fld="warranty">
            <option value="ALL">All</option>
            <option value="cpo">CPO only</option>
            <option value="factory">Factory remaining</option>
            <option value="hybrid">Hybrid coverage only</option>
            <option value="not_expired">Any coverage left</option>
          </select>
        </label>
        <label><input type="checkbox" data-fld="brandOnly"> Brand-name dealer only</label>
        <label><input type="checkbox" data-fld="cpoOnly">
          <span class="cpo-tooltip" title="Certified Pre-Owned: factory-backed warranty extension via the brand dealer (e.g. Toyota Certified Used, Mazda CPO).">CPO only</span>
        </label>
        <button class="reset" type="button">Reset</button>
        <span class="count"></span>
      </div>
      <table>
        <thead><tr>
          <th class="col-match sortable" data-key="match"
              title="Personalized match based on your priorities — set in the Customize panel above.">Match</th>
          <th class="sortable asc" data-key="deal_score">Deal</th>
          <th class="sortable" data-key="year">Year</th>
          <th class="sortable" data-key="title">Title</th>
          <th class="sortable" data-key="total_price"
              title="Out-the-door: sticker + 12% BC tax + doc/ICBC fee. Hover any cell for breakdown.">Total ⓘ</th>
          <th class="sortable" data-key="km">KM</th>
          <th class="sortable" data-key="grade">Dealer</th>
          <th class="sortable" data-key="warranty_cls"
              title="Warranty status derived from year, km, CPO badge, and the manufacturer's factory warranty schedule. Hover any cell for the specific coverage.">Warranty ⓘ</th>
          <th class="hide-sm sortable" data-key="location">Location</th>
          <th>Link</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      <div class="legend">
        <span>🔥 &lt; -10% (hot)</span>
        <span>✅ -10% to -3% (good)</span>
        <span>· -3% to +5% (fair)</span>
        <span>⚠ &gt; +5% (above market)</span>
        <span class="grade A">A</span>
        <span class="grade B">B</span>
        <span class="grade C">C</span>
        <span class="grade D">D</span>
        <span class="grade F">F</span>
      </div>`;

    const tbody = panel.querySelector('tbody');
    const countEl = panel.querySelector('.count');
    const headers = panel.querySelectorAll('th.sortable');

    function rerender() {
      panel.classList.toggle('match-on', !!matrixState.active);
      // If matrix just turned on/off, prefer sorting by match desc
      if (matrixState.active && state.sortKey !== 'match') {
        // don't override if user already chose another key intentionally
      }
      const out = applyFilterSort(search.items, state);
      tbody.innerHTML = out.map(rowHtml).join('');
      countEl.textContent = `${out.length} of ${search.items.length} listings`;
      headers.forEach(h => {
        h.classList.remove('asc', 'desc');
        if (h.dataset.key === state.sortKey) {
          h.classList.add(state.sortDir === 1 ? 'asc' : 'desc');
        }
      });
    }
    matrixListeners.push(rerender);

    panel.querySelectorAll('[data-fld]').forEach(el => {
      el.addEventListener('change', () => {
        const f = el.dataset.fld;
        state[f] = el.type === 'checkbox' ? el.checked : el.value;
        rerender();
      });
    });
    panel.querySelector('.reset').addEventListener('click', () => {
      state.brandOnly = false; state.cpoOnly = false;
      state.minGrade = 'ALL'; state.source = 'ALL'; state.warranty = 'ALL';
      state.sortKey = 'deal_score'; state.sortDir = 1;
      panel.querySelectorAll('input[type=checkbox][data-fld]').forEach(c => c.checked = false);
      panel.querySelectorAll('select[data-fld]').forEach(s => s.value = 'ALL');
      rerender();
    });
    headers.forEach(h => {
      h.addEventListener('click', () => {
        const k = h.dataset.key;
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else {
          state.sortKey = k;
          // ascending default for "smaller is better" columns
          // descending default for "higher is better" (match, grade, year, etc.)
          state.sortDir = (k === 'deal_score' || k === 'total_price' || k === 'km') ? 1 : -1;
        }
        rerender();
      });
    });

    rerender();
    return panel;
  }

  function buildDealersPanel(dealers, idx) {
    const panel = document.createElement('div');
    panel.id = 'panel-' + idx;
    panel.className = 'panel';
    if (!dealers || !dealers.length) {
      panel.innerHTML = `<h2>Dealers</h2><div class="empty">No dealers yet.</div>`;
      return panel;
    }
    const state = {
      sortKey: 'grade_score', sortDir: -1,
      brandOnly: false, cpoOnly: false, minGrade: 'ALL',
    };
    function dealerRow(d) {
      return `<tr>
        <td>${gradeBadge(d.grade, d.grade_score)}</td>
        <td>${esc(d.name || '—')}${d.brand_match ? ' <span class="badge brand">brand</span>' : ''}</td>
        <td>${d.rating != null ? '⭐' + d.rating : '—'}</td>
        <td>${(d.review_count || 0).toLocaleString()}</td>
        <td>${d.inventory || 0}</td>
        <td>${d.cpo_count || 0}</td>
        <td class="hide-sm">${esc(d.google_match || '')}</td>
      </tr>`;
    }
    function rerender() {
      const minRank = GRADE_RANK[state.minGrade] || 0;
      let out = dealers.filter(d => {
        if (state.brandOnly && !d.brand_match)    return false;
        if (state.cpoOnly   && !(d.cpo_count > 0)) return false;
        if (state.minGrade !== 'ALL' && (GRADE_RANK[d.grade] || 0) < minRank) return false;
        return true;
      });
      const k = state.sortKey;
      out.sort((a, b) => {
        let av = a[k], bv = b[k];
        if (k === 'grade') { av = GRADE_RANK[av] || 0; bv = GRADE_RANK[bv] || 0; }
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string') return av.localeCompare(bv) * state.sortDir;
        return (av - bv) * state.sortDir;
      });
      tbody.innerHTML = out.map(dealerRow).join('');
      countEl.textContent = `${out.length} of ${dealers.length} dealers`;
      headers.forEach(h => {
        h.classList.remove('asc', 'desc');
        if (h.dataset.key === state.sortKey) {
          h.classList.add(state.sortDir === 1 ? 'asc' : 'desc');
        }
      });
    }
    panel.innerHTML = `
      <h2>Dealer reliability ranking</h2>
      <div class="panel-meta">Grade = rating + review count + brand-match + CPO + inventory size. Hover the badge for raw score.</div>
      <div class="filter-bar">
        <label>Min grade
          <select data-fld="minGrade">
            <option value="ALL">All</option>
            <option value="A">A only</option>
            <option value="B">A or B</option>
            <option value="C">A–C</option>
            <option value="D">A–D</option>
          </select>
        </label>
        <label><input type="checkbox" data-fld="brandOnly"> Brand-name only</label>
        <label><input type="checkbox" data-fld="cpoOnly"> Has CPO listings</label>
        <button class="reset" type="button">Reset</button>
        <span class="count"></span>
      </div>
      <table>
        <thead><tr>
          <th class="sortable desc" data-key="grade_score">Grade</th>
          <th class="sortable" data-key="name">Dealer</th>
          <th class="sortable" data-key="rating">Rating</th>
          <th class="sortable" data-key="review_count">Reviews</th>
          <th class="sortable" data-key="inventory">In our results</th>
          <th class="sortable" data-key="cpo_count">CPO listings</th>
          <th class="hide-sm">Google match</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    const tbody   = panel.querySelector('tbody');
    const countEl = panel.querySelector('.count');
    const headers = panel.querySelectorAll('th.sortable');

    panel.querySelectorAll('[data-fld]').forEach(el => {
      el.addEventListener('change', () => {
        const f = el.dataset.fld;
        state[f] = el.type === 'checkbox' ? el.checked : el.value;
        rerender();
      });
    });
    panel.querySelector('.reset').addEventListener('click', () => {
      state.brandOnly = false; state.cpoOnly = false; state.minGrade = 'ALL';
      state.sortKey = 'grade_score'; state.sortDir = -1;
      panel.querySelectorAll('input[type=checkbox][data-fld]').forEach(c => c.checked = false);
      panel.querySelector('select[data-fld=minGrade]').value = 'ALL';
      rerender();
    });
    headers.forEach(h => {
      h.addEventListener('click', () => {
        const k = h.dataset.key;
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else { state.sortKey = k; state.sortDir = -1; }
        rerender();
      });
    });
    rerender();
    return panel;
  }

  function buildDealerTourPanel(searches, dealers, idx) {
    const panel = document.createElement('div');
    panel.id = 'panel-' + idx;
    panel.className = 'panel';

    // Index dealers by id, attach their listings from all searches
    const byId = {};
    dealers.forEach(d => { byId[d.id] = { ...d, listings: [] }; });
    searches.forEach(s => {
      s.items.forEach(it => {
        if (it.seller_id && byId[it.seller_id]) {
          byId[it.seller_id].listings.push({ ...it, search: s.name });
        }
      });
    });

    const allDealers = Object.values(byId).filter(d => d.listings.length > 0);
    if (!allDealers.length) {
      panel.innerHTML = `<h2>Dealer tour plan</h2>
        <div class="empty">No dealer-attached listings yet.</div>`;
      return panel;
    }

    // Compute per-dealer best deal score
    allDealers.forEach(d => {
      d.listings.sort((a, b) => (a.deal_score ?? 1) - (b.deal_score ?? 1));
      d.best_deal = d.listings[0].deal_score;
    });

    const state = {
      sort: 'best_deal',   // best_deal | grade | listings
      minGrade: 'ALL',
      cpoOnly: false,
      planned: new Set(JSON.parse(localStorage.getItem('dealer-tour-planned') || '[]')),
    };

    function rankedDealers() {
      let out = allDealers.filter(d => {
        if (state.minGrade !== 'ALL' && (GRADE_RANK[d.grade] || 0) < (GRADE_RANK[state.minGrade] || 0)) return false;
        if (state.cpoOnly && !d.listings.some(l => l.is_cpo)) return false;
        return true;
      });
      if (state.sort === 'best_deal') {
        out.sort((a, b) => (a.best_deal ?? 1) - (b.best_deal ?? 1));
      } else if (state.sort === 'grade') {
        out.sort((a, b) => (GRADE_RANK[b.grade] || 0) - (GRADE_RANK[a.grade] || 0)
                          || (a.best_deal ?? 1) - (b.best_deal ?? 1));
      } else if (state.sort === 'listings') {
        out.sort((a, b) => b.listings.length - a.listings.length);
      }
      return out;
    }

    function dealerCardHtml(d) {
      const top = d.listings.slice(0, 5);
      const rows = top.map(it => {
        const [label, cls] = flagFor(it.deal_score);
        const total = totalPrice(it);
        const make = (it.search || '').split(' ')[0];   // approximate
        return `<tr>
          <td class="deal ${cls}">${label} ${fmtPct(it.deal_score)}</td>
          <td>${it.year ?? '?'}</td>
          <td>${esc(it.title.length > 50 ? it.title.slice(0,50)+'…' : it.title)}</td>
          <td>${fmtMoney(total)}</td>
          <td>${fmtKm(it.km)}</td>
          <td>${warrantyCell(it)}</td>
          <td><a href="${esc(it.url)}" target="_blank" rel="noopener">view ↗</a> ${noteBtnHtml(it.url)} ${aiBtnHtml(it.url)} ${compareBtnHtml(it.url)}</td>
        </tr>`;
      }).join('');
      const moreCount = d.listings.length - top.length;
      const moreNote = moreCount > 0 ? `<tr><td colspan="7" style="color:#6b7280;font-style:italic;">…and ${moreCount} more listing${moreCount > 1 ? 's' : ''} from this dealer</td></tr>` : '';
      const checked = state.planned.has(d.id) ? 'checked' : '';
      return `<div class="dealer-card${state.planned.has(d.id) ? ' planned' : ''}" data-dealer="${esc(d.id)}">
        <div class="dealer-card-header">
          <span class="grade ${(d.grade && /^[A-F]$/.test(d.grade)) ? d.grade : 'U'} dealer-card-grade">${esc(d.grade || '?')}</span>
          <div class="dealer-card-info">
            <h3>${esc(d.name || '—')}${d.brand_match ? ' <span class="badge brand">brand</span>' : ''}${d.listings.some(l => l.is_cpo) ? ' <span class="badge cpo">CPO available</span>' : ''}</h3>
            <div class="dealer-card-meta">
              ${d.rating != null ? '⭐' + d.rating + ' (' + (d.review_count || 0).toLocaleString() + ' Google reviews)' : 'No Google match'}
               · ${d.listings.length} listing${d.listings.length > 1 ? 's' : ''} in your search${d.cpo_count ? ' · ' + d.cpo_count + ' CPO' : ''}
            </div>
            <div class="dealer-card-addr">${esc(d.google_match || '')}</div>
          </div>
          <span class="dealer-card-best">Best: ${fmtPct(d.best_deal)}</span>
          <label class="visit-check"><input type="checkbox" data-plan="${esc(d.id)}" ${checked}>Plan visit</label>
        </div>
        <table class="listings-table">
          <thead><tr>
            <th>Deal</th><th>Year</th><th>Title</th>
            <th>Total</th><th>KM</th><th>Warranty</th><th>Link</th>
          </tr></thead>
          <tbody>${rows}${moreNote}</tbody>
        </table>
      </div>`;
    }

    function rerender() {
      const ranked = rankedDealers();
      const plannedCount = state.planned.size;
      panel.querySelector('.summary').innerHTML =
        `${ranked.length} of ${allDealers.length} dealers shown · <strong>${plannedCount}</strong> planned for visit`;
      panel.querySelector('#tour-list').innerHTML = ranked.map(dealerCardHtml).join('');
      // wire visit checkboxes
      panel.querySelectorAll('input[data-plan]').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.dataset.plan;
          if (cb.checked) state.planned.add(id); else state.planned.delete(id);
          try { localStorage.setItem('dealer-tour-planned', JSON.stringify([...state.planned])); } catch (e) {}
          // toggle planned class without full re-render to avoid scroll jump
          const card = cb.closest('.dealer-card');
          if (card) card.classList.toggle('planned', cb.checked);
          panel.querySelector('.summary').innerHTML =
            `${ranked.length} of ${allDealers.length} dealers shown · <strong>${state.planned.size}</strong> planned for visit`;
        });
      });
    }

    panel.innerHTML = `
      <h2>🗺️ Dealer tour — plan which dealerships to visit</h2>
      <div class="panel-meta">Ranked so the dealership with the hottest single offer is first. Tick "Plan visit" to mark a dealer; tick a few then use Print to get a paper itinerary of just your planned visits.</div>
      <div class="tour-controls">
        <label>Sort by
          <select data-fld="sort">
            <option value="best_deal">Best deal at dealer</option>
            <option value="grade">Dealer grade</option>
            <option value="listings">Most listings</option>
          </select>
        </label>
        <label>Min grade
          <select data-fld="minGrade">
            <option value="ALL">All</option>
            <option value="A">A only</option>
            <option value="B">A or B</option>
            <option value="C">A–C</option>
          </select>
        </label>
        <label><input type="checkbox" data-fld="cpoOnly"> Has CPO offers</label>
        <button class="reset" type="button" style="background:#fff;color:#b91c1c;border:1px solid #fecaca;padding:4px 10px;border-radius:4px;cursor:pointer;">Clear plan</button>
        <span class="summary"></span>
      </div>
      <div id="tour-list"></div>`;

    panel.querySelectorAll('[data-fld]').forEach(el => {
      el.addEventListener('change', () => {
        const f = el.dataset.fld;
        state[f] = el.type === 'checkbox' ? el.checked : el.value;
        rerender();
      });
    });
    panel.querySelector('.reset').addEventListener('click', () => {
      if (!state.planned.size || confirm('Clear all planned visits?')) {
        state.planned.clear();
        try { localStorage.removeItem('dealer-tour-planned'); } catch (e) {}
        rerender();
      }
    });

    rerender();
    return panel;
  }

  function buildStatusPanel(searches, runs, idx) {
    const panel = document.createElement('div');
    panel.id = 'panel-' + idx;
    panel.className = 'panel';

    const SOURCES = ['autotrader', 'kijiji'];
    const SOURCE_LABEL = { autotrader: 'AutoTrader', kijiji: 'Kijiji' };
    const STATUS_LABEL = {
      ok: 'OK', blocked: 'Blocked', no_results: 'No results',
      error: 'Error', never: 'Never run',
    };
    const STATUS_ICON = {
      ok: '✅', blocked: '⛔', no_results: '·',
      error: '❌', never: '⏳',
    };

    // Index runs by (search, source)
    const byKey = {};
    (runs || []).forEach(r => { byKey[r.search_name + '|' + r.source] = r; });

    // Build a row for every expected pair (even if no run yet)
    const rows = [];
    searches.forEach(s => {
      SOURCES.forEach(src => {
        const key = s.name + '|' + src;
        rows.push({
          search: s.name, source: src,
          run: byKey[key] || null,
        });
      });
    });

    // Summary counts
    const seen = rows.filter(r => r.run);
    const okN     = seen.filter(r => r.run.status === 'ok').length;
    const blockN  = seen.filter(r => r.run.status === 'blocked').length;
    const emptyN  = seen.filter(r => r.run.status === 'no_results').length;
    const errN    = seen.filter(r => r.run.status === 'error').length;
    const neverN  = rows.length - seen.length;

    const summaryHtml = `
      <div class="status-summary">
        <div class="status-card ok"><div class="num">${okN}</div><div class="lbl">OK</div></div>
        <div class="status-card warn"><div class="num">${blockN}</div><div class="lbl">Blocked</div></div>
        <div class="status-card"><div class="num">${emptyN}</div><div class="lbl">No results</div></div>
        <div class="status-card err"><div class="num">${errN}</div><div class="lbl">Errors</div></div>
        ${neverN ? `<div class="status-card warn"><div class="num">${neverN}</div><div class="lbl">Never run</div></div>` : ''}
      </div>`;

    const trs = rows.map(r => {
      const run = r.run;
      const status = run ? run.status : 'never';
      const when = run ? relativeAgo(run.finished_at).text : '—';
      const fullWhen = run
        ? new Date(run.finished_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
        : '';
      return `<tr>
        <td>${esc(r.search)}</td>
        <td><span class="badge src-${r.source}">${SOURCE_LABEL[r.source]}</span></td>
        <td><span class="status-badge ${status}">${STATUS_ICON[status]} ${STATUS_LABEL[status]}</span></td>
        <td>${run ? run.listings : '—'}</td>
        <td title="${esc(fullWhen)}">${when}</td>
        <td class="status-msg">${esc(run && run.message ? run.message : '')}</td>
      </tr>`;
    }).join('');

    panel.innerHTML = `
      <h2>📡 Scrape status</h2>
      <div class="panel-meta">Last run per source for each search. <strong>OK</strong> = listings returned; <strong>Blocked</strong> = the site served a challenge page (CAPTCHA / bot check); <strong>No results</strong> = page loaded but had zero cards; <strong>Error</strong> = exception during scrape.</div>
      ${summaryHtml}
      <table>
        <thead><tr>
          <th>Search</th>
          <th>Source</th>
          <th>Status</th>
          <th>Listings</th>
          <th>Last run</th>
          <th>Message</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>`;
    return panel;
  }

  // Compare panel + tab badge — populated lazily
  let comparePanelEl = null;
  function renderComparePanel() {
    if (!comparePanelEl) return;
    const items = [...compareCart].map(findListingByUrl).filter(Boolean);
    const tab = document.getElementById('tab-compare');
    if (tab) tab.textContent = compareCart.size ? `⚖ Compare (${compareCart.size})` : '⚖ Compare';

    if (!items.length) {
      comparePanelEl.innerHTML = `
        <h2>⚖ Compare cars</h2>
        <div class="panel-meta">Tick the checkbox at the end of any listing row to add a car here. Maximum 5.</div>
        <div class="empty">No cars selected yet.</div>`;
      return;
    }

    const total = it => totalPrice(it);
    const cell = (label, render) => `
      <tr><td>${label}</td>${items.map(f => `<td class="car-col">${render(f.it)}</td>`).join('')}</tr>`;

    const rows = [
      cell('Title',       it => esc(it.title)),
      cell('Year',        it => it.year ?? '?'),
      cell('Sticker',     it => fmtMoney(it.price)),
      cell('Out-the-door (est.)', it => fmtMoney(total(it))),
      cell('Odometer',    it => fmtKm(it.km)),
      cell('Deal score',  it => {
        const [lbl, cls] = flagFor(it.deal_score);
        return `<span class="deal ${cls}">${lbl} ${fmtPct(it.deal_score)}</span>`;
      }),
      cell('Source',      it => sourceBadge(it.source)),
      cell('Dealer',      it => esc(it.seller_name || '—')),
      cell('Dealer grade',it => gradeBadge(it.grade, it.grade_score)
                              + (it.brand_match ? ' <span class="badge brand">brand</span>' : '')
                              + (it.is_cpo ? ' <span class="badge cpo">CPO</span>' : '')),
      cell('Google reviews', it => it.rating != null
                                   ? `⭐${it.rating} (${(it.review_count||0).toLocaleString()})`
                                   : '—'),
      cell('Warranty',    it => warrantyCell(it)),
      cell('Location',    it => esc(it.location || '—')),
      cell('My note',     it => {
        const n = getNote(it.url);
        const ac = attachCounts[it.url] || 0;
        if (!n && !ac) return '<span style="color:#9ca3af">none</span>';
        const parts = [];
        if (n) parts.push(esc(n.length > 90 ? n.slice(0, 87) + '…' : n));
        if (ac) parts.push(`<em>${ac} attached file${ac > 1 ? 's' : ''}</em>`);
        return parts.join('<br>');
      }),
      cell('Link',        it => `<a href="${esc(it.url)}" target="_blank" rel="noopener">view ↗</a>`),
      cell('',            it => `<button class="compare-remove" data-compare-remove="${esc(it.url)}">Remove</button>`),
    ].join('');

    comparePanelEl.innerHTML = `
      <h2>⚖ Compare ${items.length} car${items.length > 1 ? 's' : ''}</h2>
      <div class="panel-meta">Side-by-side view of cars in your compare cart. The 🤖 button below sends all of them to an AI with your priorities for a cross-comparison recommendation.</div>
      <div class="compare-actions">
        <button class="primary" id="compare-tab-ai">🤖 Ask AI for cross-comparison recommendation</button>
        <button class="ghost" id="compare-tab-clear">Clear all (${items.length})</button>
      </div>
      <div style="overflow-x: auto;">
        <table class="compare-table">
          <thead><tr>
            <th></th>
            ${items.map((f, i) => `<th class="car-col">Car ${i + 1}</th>`).join('')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    comparePanelEl.querySelector('#compare-tab-ai').onclick = () => compareSelected();
    comparePanelEl.querySelector('#compare-tab-clear').onclick = () => {
      if (!confirm(`Clear all ${compareCart.size} selected car${compareCart.size > 1 ? 's' : ''}?`)) return;
      compareCart.clear();
      saveCompare();
    };
    comparePanelEl.querySelectorAll('button[data-compare-remove]').forEach(b => {
      b.onclick = () => {
        compareCart.delete(b.dataset.compareRemove);
        saveCompare();
      };
    });
  }

  function buildComparePanel(idx) {
    const panel = document.createElement('div');
    panel.id = 'panel-' + idx;
    panel.className = 'panel';
    comparePanelEl = panel;
    renderComparePanel();
    return panel;
  }

  function makeTab(label, idx, isActive) {
    const t = document.createElement('button');
    t.className = 'tab' + (isActive ? ' active' : '');
    t.textContent = label;
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + idx).classList.add('active');
    };
    return t;
  }

  payload.searches.forEach((search, idx) => {
    tabsEl.appendChild(makeTab(`${search.name} (${search.items.length})`, idx, idx === 0));
    panelsEl.appendChild(buildSearchPanel(search, idx));
  });

  const dealersIdx = payload.searches.length;
  tabsEl.appendChild(makeTab(`🏪 Dealers (${(payload.dealers || []).length})`, dealersIdx, false));
  panelsEl.appendChild(buildDealersPanel(payload.dealers || [], dealersIdx));

  const tourIdx = dealersIdx + 1;
  tabsEl.appendChild(makeTab(`🗺️ Dealer Tour`, tourIdx, false));
  panelsEl.appendChild(buildDealerTourPanel(payload.searches, payload.dealers || [], tourIdx));

  const statusIdx = tourIdx + 1;
  const okCount = (payload.runs || []).filter(r => r.status === 'ok').length;
  const expectedCount = (payload.searches.length * 2);   // 2 sources per search
  tabsEl.appendChild(makeTab(`📡 Status (${okCount}/${expectedCount})`, statusIdx, false));
  panelsEl.appendChild(buildStatusPanel(payload.searches, payload.runs || [], statusIdx));

  const compareIdx = statusIdx + 1;
  const compareTabLabel = compareCart.size ? `⚖ Compare (${compareCart.size})` : '⚖ Compare';
  const compareTab = makeTab(compareTabLabel, compareIdx, false);
  compareTab.id = 'tab-compare';
  tabsEl.appendChild(compareTab);
  panelsEl.appendChild(buildComparePanel(compareIdx));

  setupMatrixUI();
  setupRescrape();

  // ── Re-scrape: triggers server-side scraper + streams progress ───────
  function setupRescrape() {
    const btn       = document.getElementById('rescrape-btn');
    const overlay   = document.getElementById('scrape-overlay');
    const stepsEl   = document.getElementById('scrape-steps');
    const barFill   = document.getElementById('scrape-bar-fill');
    const progText  = document.getElementById('scrape-progress-text');
    const elapsed   = document.getElementById('scrape-elapsed');
    const logEl     = document.getElementById('scrape-log');
    const closeBtn  = document.getElementById('scrape-close');

    // ── Step model: 2 per search (autotrader + kijiji) + enrich + write ───
    const SEARCH_NAMES = payload.searches.map(s => s.name);
    const SOURCES = ['autotrader', 'kijiji'];
    let steps = [];
    function buildSteps() {
      steps = [];
      SEARCH_NAMES.forEach(name => SOURCES.forEach(src => {
        steps.push({ kind: 'scrape', name, src, status: 'pending', count: null });
      }));
      steps.push({ kind: 'enrich', dealersTotal: null, dealersDone: 0, status: 'pending' });
      steps.push({ kind: 'write', status: 'pending' });
      renderSteps();
    }
    function renderSteps() {
      stepsEl.innerHTML = steps.map(s => {
        let icon, label, count = '';
        if (s.kind === 'scrape') {
          label = `${esc(s.name)} — <strong>${SOURCE_LABEL_SHORT[s.src]}</strong>`;
          icon = STATUS_ICON[s.status];
          if (s.count != null) count = `${s.count} listings`;
        } else if (s.kind === 'enrich') {
          label = '🏪 Dealer enrichment (Google Places)';
          icon = STATUS_ICON[s.status];
          if (s.dealersTotal) count = `${s.dealersDone} / ${s.dealersTotal} dealers`;
        } else if (s.kind === 'write') {
          label = '📄 Write deals_report.md + index.html';
          icon = STATUS_ICON[s.status];
        }
        return `<div class="scrape-step ${s.status}">
          <span class="ico">${icon}</span>
          <span class="label">${label}</span>
          <span class="count">${count}</span>
        </div>`;
      }).join('');
      updateProgressBar();
    }
    const SOURCE_LABEL_SHORT = { autotrader: 'AutoTrader', kijiji: 'Kijiji' };
    const STATUS_ICON = {
      pending: '⏳',
      running: '🔄',
      ok:      '✅',
      blocked: '⛔',
      error:   '❌',
    };
    function updateProgressBar() {
      const total = steps.length;
      let weighted = 0;
      steps.forEach(s => {
        if (s.status === 'ok') weighted += 1;
        else if (s.status === 'running' && s.kind === 'enrich' && s.dealersTotal) {
          weighted += s.dealersDone / s.dealersTotal;
        } else if (s.status === 'running') weighted += 0.5;
        else if (s.status === 'blocked' || s.status === 'error') weighted += 1;
      });
      const pct = total ? Math.round(weighted / total * 100) : 0;
      barFill.style.width = pct + '%';
      const okCount = steps.filter(s => s.status === 'ok').length;
      const doneCount = steps.filter(s => s.status !== 'pending' && s.status !== 'running').length;
      progText.textContent = `${okCount} OK · ${doneCount} / ${total} steps · ${pct}%`;
    }
    function elapsedStr(secs) {
      const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
      return `${m}:${String(s).padStart(2,'0')}`;
    }

    let startedAt = null;
    let elapsedTimer = null;
    function startElapsed(ts) {
      startedAt = ts;
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = setInterval(() => {
        if (startedAt) elapsed.textContent = elapsedStr(Date.now()/1000 - startedAt);
      }, 1000);
    }
    function stopElapsed() {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    }

    // ── Parsing scraper stdout ──────────────────────────────────────────
    let currentSearch = null;
    function parseLog(text) {
      logEl.textContent += text + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
      let m;
      if (m = text.match(/^🔎\s+(.+)$/)) {
        currentSearch = m[1].trim();
        // Mark autotrader step running for this search
        const i = steps.findIndex(s => s.kind==='scrape' && s.name===currentSearch && s.src==='autotrader');
        if (i >= 0 && steps[i].status === 'pending') {
          steps[i].status = 'running'; renderSteps();
        }
        return;
      }
      // "autotrader: ✅ ok, 80 listings" or "kijiji: ⛔ blocked, 0 listings"
      if (m = text.match(/^\s*(autotrader|kijiji):\s*\S+\s+(ok|blocked|no_results|error),\s*(\d+)\s+listings/)) {
        const src = m[1];
        const status = m[2] === 'no_results' ? 'ok' : m[2];   // no_results still counts as completed
        const n = parseInt(m[3], 10);
        const i = steps.findIndex(s => s.kind==='scrape' && s.name===currentSearch && s.src===src);
        if (i >= 0) {
          steps[i].status = status;
          steps[i].count = n;
          // If this was AT, mark kijiji as running next; if Kijiji, search is done
          if (src === 'autotrader') {
            const ki = i + 1;
            if (steps[ki] && steps[ki].status === 'pending') steps[ki].status = 'running';
          }
          renderSteps();
        }
        return;
      }
      // "🏪 Enriching 57 unique dealer(s)…"
      if (m = text.match(/Enriching\s+(\d+)\s+unique dealer/)) {
        const ei = steps.findIndex(s => s.kind === 'enrich');
        if (ei >= 0) {
          steps[ei].status = 'running';
          steps[ei].dealersTotal = parseInt(m[1], 10);
          steps[ei].dealersDone = 0;
          renderSteps();
        }
        return;
      }
      // " · Dealer Name → ⭐4.5 / 1234 reviews"  OR  " · Dealer Name → no Google match"
      if (text.match(/^\s+·\s+.+→/)) {
        const ei = steps.findIndex(s => s.kind === 'enrich');
        if (ei >= 0 && steps[ei].status === 'running') {
          steps[ei].dealersDone++;
          renderSteps();
        }
        return;
      }
      // "🌐 HTML report written: car-deals/index.html"
      if (text.includes('HTML report written')) {
        const ei = steps.findIndex(s => s.kind === 'enrich');
        if (ei >= 0 && steps[ei].status === 'running') {
          steps[ei].status = 'ok';
          if (steps[ei].dealersTotal) steps[ei].dealersDone = steps[ei].dealersTotal;
        }
        const wi = steps.findIndex(s => s.kind === 'write');
        if (wi >= 0) steps[wi].status = 'ok';
        renderSteps();
        return;
      }
    }

    // ── Server interaction ──────────────────────────────────────────────
    let sse = null;
    function openSSE() {
      if (sse) sse.close();
      sse = new EventSource('/api/scrape-stream');
      sse.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'start') {
          buildSteps();
          logEl.textContent = '';
          startElapsed(msg.at);
        } else if (msg.type === 'log') {
          parseLog(msg.text);
        } else if (msg.type === 'done') {
          finishScrape(msg.code);
        }
      };
      sse.onerror = () => { /* browser will auto-reconnect */ };
    }

    function finishScrape(code) {
      stopElapsed();
      closeBtn.disabled = false;
      if (code === 0) {
        progText.textContent = '✅ Done — reloading…';
        setTimeout(() => location.reload(), 1500);
      } else {
        progText.textContent = `❌ Exited with code ${code}`;
      }
    }

    async function probeServer() {
      try {
        const r = await fetch('/api/scrape-status', { method: 'GET' });
        if (!r.ok) return false;
        const data = await r.json();
        btn.classList.remove('hidden');
        if (data.running) {
          overlay.classList.add('open');
          buildSteps();
          // Replay any logs already collected
          (data.log || []).forEach(ev => {
            if (ev.type === 'log') parseLog(ev.text);
            else if (ev.type === 'start') startElapsed(ev.at);
          });
          openSSE();
        }
        return true;
      } catch (e) {
        return false;   // Not on local server (Firebase, file://, etc.) — keep button hidden
      }
    }

    btn.addEventListener('click', async () => {
      if (!confirm('Start a fresh scrape now? Chromium will open. Takes ~6-8 min. Click OK to begin.')) return;
      btn.disabled = true;
      try {
        const r = await fetch('/api/scrape', { method: 'POST' });
        if (r.status === 202 || r.ok) {
          overlay.classList.add('open');
          buildSteps();
          closeBtn.disabled = true;
          logEl.textContent = '';
          openSSE();
        } else if (r.status === 409) {
          overlay.classList.add('open');
          buildSteps();
          openSSE();
        } else {
          alert('Could not start scrape: HTTP ' + r.status);
        }
      } catch (e) {
        alert('Server error: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    });

    closeBtn.addEventListener('click', () => {
      overlay.classList.remove('open');
      if (sse) { sse.close(); sse = null; }
    });

    probeServer();
  }
})();
</script>
</body>
</html>"""

def write_html_report(conn: sqlite3.Connection, out_dir: str) -> None:
    # Only include listings seen in the most recent OK scrape for their
    # (search_name, source) — anything older is treated as expired/sold.
    rows = conn.execute("""
        WITH latest_ok AS (
            SELECT search_name, source, MAX(started_at) AS latest_run_start
            FROM scrape_runs
            WHERE status = 'ok'
            GROUP BY search_name, source
        )
        SELECT l.search_name, l.year, l.title, l.price, l.km, l.location,
               l.deal_score, l.url, l.is_cpo, l.source,
               l.seller_id, l.seller_name,
               d.rating, d.review_count, d.brand_match, d.grade, d.grade_score,
               d.google_match
        FROM listings l
        LEFT JOIN dealers d ON d.customer_id = l.seller_id
        LEFT JOIN latest_ok lo
               ON lo.search_name = l.search_name
              AND lo.source      = l.source
        WHERE l.deal_score IS NOT NULL
          AND (lo.latest_run_start IS NULL
               OR l.scraped_at >= lo.latest_run_start)
        ORDER BY l.search_name, l.deal_score ASC
    """).fetchall()

    grouped: dict[str, list[dict]] = {}
    for (search_name, year, title, price, km, loc, score, url, is_cpo, source,
         seller_id, seller_name, rating, review_count, brand_match,
         grade, grade_score, google_match) in rows:
        warranty = warranty_for(year, km, search_name, bool(is_cpo))
        grouped.setdefault(search_name, []).append({
            "year": year, "title": title, "price": price, "km": km,
            "location": loc, "deal_score": score, "url": url,
            "is_cpo": bool(is_cpo),
            "source": source,
            "seller_id": seller_id,
            "seller_name": seller_name,
            "rating": rating,
            "review_count": review_count,
            "brand_match": bool(brand_match),
            "grade": grade,
            "grade_score": grade_score,
            "google_match": google_match,
            "warranty_label":  warranty["label"],
            "warranty_detail": warranty["detail"],
            "warranty_cls":    warranty["cls"],
        })

    # also embed a top-dealers ranking
    dealer_rows = conn.execute("""
        SELECT customer_id, name, google_match, rating, review_count,
               brand_match, inventory, cpo_count, grade, grade_score
        FROM dealers
        ORDER BY grade_score DESC, review_count DESC
    """).fetchall()
    dealers = [
        {"id": r[0], "name": r[1], "google_match": r[2], "rating": r[3],
         "review_count": r[4], "brand_match": bool(r[5]),
         "inventory": r[6], "cpo_count": r[7], "grade": r[8],
         "grade_score": r[9]}
        for r in dealer_rows
    ]

    # Latest run per (search, source) for the Status tab
    run_rows = conn.execute("""
        SELECT search_name, source, started_at, finished_at, status, listings, message
        FROM scrape_runs
        WHERE id IN (
            SELECT MAX(id) FROM scrape_runs GROUP BY search_name, source
        )
        ORDER BY search_name, source
    """).fetchall()
    runs = [
        {"search_name": r[0], "source": r[1], "started_at": r[2],
         "finished_at": r[3], "status": r[4], "listings": r[5], "message": r[6]}
        for r in run_rows
    ]

    payload = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "total": sum(len(v) for v in grouped.values()),
        "searches": [{"name": k, "items": v} for k, v in grouped.items()],
        "dealers": dealers,
        "runs": runs,
    }

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    html = HTML_TEMPLATE.replace("__DATA__", json.dumps(payload))
    (out / "index.html").write_text(html)
    (out / "data.json").write_text(json.dumps(payload, indent=2))
    print(f"🌐 HTML report written: {out / 'index.html'}")

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

async def main(skip_scrape: bool = False) -> None:
    conn = init_db(DB_PATH)

    if not skip_scrape:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=HEADLESS)
            context = await browser.new_context(
                user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/124.0.0.0 Safari/537.36"),
                viewport={"width": 1366, "height": 900},
                locale="en-CA",
            )
            page = await context.new_page()

            for cfg in SEARCHES:
                print(f"\n🔎 {cfg['name']}")
                for src, scraper in (("autotrader", scrape_autotrader),
                                     ("kijiji",     scrape_kijiji)):
                    started = datetime.utcnow().isoformat(timespec="seconds")
                    try:
                        n, status, msg = await scraper(page, cfg, conn)
                    except Exception as e:
                        n, status, msg = 0, "error", str(e)[:300]
                        print(f"  {src} error: {msg}")
                    record_run(conn, cfg["name"], src, started, status, n, msg)
                    label = {"ok":"✅","blocked":"⛔","no_results":"·","error":"❌"}.get(status, "?")
                    print(f"  {src}: {label} {status}, {n} listings"
                          + (f" ({msg})" if msg else ""))

            await browser.close()
    else:
        print("⏭  --skip-scrape: regenerating reports from existing DB")

    for cfg in SEARCHES:
        score_search(conn, cfg["name"])

    enrich_dealers(conn)

    write_report(conn, REPORT_PATH)
    write_html_report(conn, HTML_DIR)
    conn.close()


if __name__ == "__main__":
    import sys
    asyncio.run(main(skip_scrape="--skip-scrape" in sys.argv))
