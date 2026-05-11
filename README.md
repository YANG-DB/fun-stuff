# Fun & Experimental Projects

A collection of experimental projects and fun applications. This repository serves as a playground for exploring new ideas, building interactive tools, and creating useful utilities.

## Projects

### BC Trip Planner
**File:** [bc-trip-planner.html](bc-trip-planner.html)

An interactive single-page application for planning trips around Vancouver and British Columbia. Perfect for visitors exploring the beauty of BC.

**Features:**
- Interactive map with 24+ destinations across BC
- Four trip categories:
  - Day Trips (All Family) - Family-friendly attractions
  - Day Trips (Trails) - Hiking and outdoor adventures
  - Day Trips (City Tour) - Urban exploration
  - Weekend Trips - Extended getaways
- Build custom trip plans by selecting locations
- Save/load multiple trip plans as JSON for comparison
- Export trip details to text format
- Color-coded markers and detailed location descriptions

**Usage:** Simply open the HTML file in any modern web browser. No installation or server required!

---

### BC Used Car Deal Finder
**Files:** [car_deal_finder.py](car_deal_finder.py) · [car-deals/index.html](car-deals/index.html) · [car-deals/checklist.html](car-deals/checklist.html)

An end-to-end Python scraper + browser-side analytics dashboard for ranking used-car listings in BC against a per-search regression model, joined with dealer reliability data from Google reviews and a derived warranty-status estimate.

**Pipeline:**
1. Playwright scrapes AutoTrader.ca and Kijiji.ca for configured make/model searches (filters by year, price, km, AWD/Hybrid, etc.)
2. SQLite stores listings + dealer metadata for resumability
3. Linear regression on `price ~ year + km` produces a per-listing **deal score** (negative = below market)
4. Google Places API (New) fetches rating + review count for each unique dealer
5. Composite **dealer grade (A–F)** combines Google reviews, review volume, brand-name match, CPO listings, and inventory size
6. **Warranty status** is derived from year + km + CPO badge against a per-make factory-warranty table (Toyota, Mazda, Honda, Nissan, Hyundai, Kia)
7. Output: a self-contained, deployable `car-deals/index.html` with embedded JSON data

**HTML report features:**
- Sortable, filterable tables per search
- **Out-the-door Total** column with hover-tooltip showing tax + fee breakdown (12% BC tax + dealer doc fee or ICBC private-transfer fee)
- **Dealer column** with letter grade + Google rating + brand/CPO badges
- **Warranty column** with color-coded badges (CPO / Factory / Hybrid only / Expired) and hover details
- **🏪 Dealers tab** ranking all unique sellers by reliability score
- **🎯 Personalized Match Score** — opt-in weighted scoring across 7 dimensions (price, mileage, year, dealer, warranty, brand, CPO) with persistence via `localStorage`
- Companion [pre-purchase checklist](car-deals/checklist.html) — printable, BC-specific, with hybrid-vehicle items and a progress tracker

**Setup:**
```bash
pip install playwright
playwright install chromium
```
Then create `.env` (already gitignored):
```
GOOGLE_API_KEY=your_places_api_key
```
Enable **Places API (New)** in your Google Cloud project and create an unrestricted (or IP-restricted) API key. Place Details calls are covered by Google's $200/mo free Maps credit at the volume this tool uses (~$0.30/run for ~20 dealers).

**Run:**
```bash
python car_deal_finder.py             # scrape + score + enrich + emit HTML
python car_deal_finder.py --skip-scrape  # regenerate reports from existing DB only
```
Output is written to `car-deals/index.html`. Open it locally, or deploy to Firebase Hosting:
```bash
firebase init hosting   # one-time
firebase deploy
```

**Configurable in [car_deal_finder.py](car_deal_finder.py):** the `SEARCHES` list (target make/model/year/price/km filters), the `WARRANTY_RULES` table, and the `TAX_RATE`/`DEALER_FEE`/`PRIVATE_FEE` constants in the embedded HTML template.

---

## About This Repository

This repo is a sandbox for:
- Quick prototypes and proof-of-concepts
- Interactive web applications
- Useful tools and utilities
- Learning experiments
- Creative side projects

Feel free to explore, use, and modify any project here!
