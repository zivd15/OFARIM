# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track visitor traffic (page views + unique sessions) in D1 and expose the data in a new "תנועה" (Traffic) tab inside the admin panel.

**Architecture:** A lightweight client-side beacon (`public/analytics.js`) fires on every public page load — production host only — and POSTs `{ page, session_id, referrer }` to a new `POST /api/analytics/hit` endpoint that writes to a new `page_views` D1 table. A new `GET /api/analytics/summary` admin route aggregates the data. The admin panel gets a second tab ("תנועה") rendering stat cards, an hourly bar chart, top pages, and top countries.

**Tech Stack:** Cloudflare D1 (SQLite), Hono, React 18 (Babel in-browser), Tailwind CDN, `sessionStorage` for session deduplication.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `public/analytics.js` | **Create** | Production-only beacon script |
| `functions/api/[[path]].js` | **Modify** | Add `POST /analytics/hit` + `GET /analytics/summary` routes |
| `public/index.html` | **Modify** | Add beacon `<script>` |
| `public/calendar.html` | **Modify** | Add beacon `<script>` |
| `public/login.html` | **Modify** | Add beacon `<script>` |
| `public/dashboard.html` | **Modify** | Add beacon `<script>` |
| `public/terms.html` | **Modify** | Add beacon `<script>` |
| `public/cancellation.html` | **Modify** | Add beacon `<script>` |
| `public/privacy.html` | **Modify** | Add beacon `<script>` |
| `public/admin.html` | **Modify** | Add `TrafficDashboard` component + tab bar to `AdminApp` |

---

## Task 1: D1 schema — add `page_views` table (staging first)

**Files:** none (wrangler CLI only)

- [ ] **Step 1: Apply the migration to staging D1**

Run from the repo root (`C:\Users\zivd1\OneDrive\Desktop\AI PROJECT\OFARIM`):

```bash
wrangler d1 execute ofarim-staging --remote --command "
CREATE TABLE IF NOT EXISTS page_views (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page        TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  country     TEXT,
  referrer    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created_at ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_session    ON page_views(session_id);
"
```

Expected output: `✅ Executed 3 commands.` (or similar success message)

- [ ] **Step 2: Verify the table was created**

```bash
wrangler d1 execute ofarim-staging --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='page_views'"
```

Expected: one row with `name = page_views`.

- [ ] **Step 3: Commit a record of the SQL (add to schema.sql if it exists, otherwise create it)**

Check whether `schema.sql` exists at the repo root:
```bash
ls schema.sql 2>/dev/null && echo "exists" || echo "missing"
```

If it exists, append to it. If missing, record the SQL in a new `docs/migrations/004_page_views.sql`:
```sql
-- Migration 004: analytics page_views table
CREATE TABLE IF NOT EXISTS page_views (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page        TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  country     TEXT,
  referrer    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created_at ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_session    ON page_views(session_id);
```

```bash
git add schema.sql   # or docs/migrations/004_page_views.sql
git commit -m "feat(analytics): add page_views table migration"
```

---

## Task 2: API — `POST /analytics/hit` + `GET /analytics/summary`

**Files:**
- Modify: `functions/api/[[path]].js` — add two routes before the `export function onRequest` line (currently line 1064)

- [ ] **Step 1: Add `POST /analytics/hit`**

Insert this block immediately before `export function onRequest(context)` (after the `send-reminders` route, around line 1063):

```js
// ── Analytics (/api/analytics/*) ────────────────────────────────────────────
// Hit endpoint: no auth required. Beacon fires client-side on every public page.
// session_id is a random token from sessionStorage — no PII stored.
app.post('/analytics/hit', async c => {
  const body = await c.req.json().catch(() => ({}))
  const page      = String(body.page       || '').slice(0, 100)
  const sessionId = String(body.session_id || '').slice(0, 64)
  const referrer  = String(body.referrer   || '').slice(0, 200)
  if (!page || !sessionId) return c.json({ ok: false }, 400)

  const country = c.req.header('CF-IPCountry') || null
  await c.env.DB.prepare(
    'INSERT INTO page_views (page, session_id, country, referrer) VALUES (?, ?, ?, ?)'
  ).bind(page, sessionId, country, referrer || null).run()

  return c.json({ ok: true })
})

// Summary endpoint: admin-only aggregated stats.
app.get('/analytics/summary', adminMiddleware, async c => {
  const db = c.env.DB
  const [today, week, month, allTime, topPages, hourly, topCountries] = await Promise.all([
    db.prepare("SELECT COUNT(*) as views, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE created_at >= datetime('now','start of day')").first(),
    db.prepare("SELECT COUNT(*) as views, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE created_at >= datetime('now','-7 days')").first(),
    db.prepare("SELECT COUNT(*) as views, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE created_at >= datetime('now','-30 days')").first(),
    db.prepare("SELECT COUNT(*) as views, COUNT(DISTINCT session_id) as sessions FROM page_views").first(),
    db.prepare("SELECT page, COUNT(*) as views, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE created_at >= datetime('now','-30 days') GROUP BY page ORDER BY views DESC LIMIT 10").all(),
    db.prepare("SELECT strftime('%H',created_at) as hour, COUNT(*) as views, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE created_at >= datetime('now','start of day') GROUP BY hour ORDER BY hour").all(),
    db.prepare("SELECT country, COUNT(DISTINCT session_id) as sessions FROM page_views WHERE created_at >= datetime('now','-30 days') AND country IS NOT NULL GROUP BY country ORDER BY sessions DESC LIMIT 10").all(),
  ])
  return c.json({
    today,
    week,
    month,
    all_time: allTime,
    top_pages:     topPages.results,
    hourly_today:  hourly.results,
    top_countries: topCountries.results,
  })
})
```

- [ ] **Step 2: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(analytics): add /analytics/hit and /analytics/summary routes"
```

---

## Task 3: Beacon script (`public/analytics.js`)

**Files:**
- Create: `public/analytics.js`

- [ ] **Step 1: Create the beacon file**

```js
// public/analytics.js
// Analytics beacon — fires once per page load on production only.
// Uses sessionStorage to assign an anonymous session ID (no PII).
(function () {
  var PROD_HOST = 'ofarim.pages.dev';
  if (location.hostname !== PROD_HOST) return;

  var sid = sessionStorage.getItem('_ofa_sid');
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('_ofa_sid', sid);
  }

  var PAGE_MAP = {
    '/':            'home',
    '/calendar':    'calendar',
    '/login':       'login',
    '/dashboard':   'dashboard',
    '/terms':       'terms',
    '/cancellation':'cancellation',
    '/privacy':     'privacy',
  };
  var path = location.pathname.replace(/\/$/, '') || '/';
  var page = PAGE_MAP[path] || path.replace(/^\//, '').split('/')[0] || 'other';

  var ref = '';
  try { if (document.referrer) ref = new URL(document.referrer).hostname; } catch (e) {}

  fetch('/api/analytics/hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: page, session_id: sid, referrer: ref }),
    keepalive: true,
  }).catch(function () {});
})();
```

- [ ] **Step 2: Commit**

```bash
git add public/analytics.js
git commit -m "feat(analytics): add production-only page-view beacon"
```

---

## Task 4: Add beacon to every public page

**Files:** Modify 7 HTML files — add one `<script>` tag to each, just before `</body>`.

> The beacon is **safe to add to all pages**: it returns immediately if `location.hostname !== 'ofarim.pages.dev'` so staging/localhost are untouched.

- [ ] **Step 1: Add to `public/index.html`**

Find the closing `</body>` tag and insert the beacon script before it:
```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 2: Add to `public/calendar.html`**

Same insertion just before `</body>`:
```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 3: Add to `public/login.html`**

```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 4: Add to `public/dashboard.html`**

```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 5: Add to `public/terms.html`**

```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 6: Add to `public/cancellation.html`**

```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 7: Add to `public/privacy.html`**

```html
<script src="/analytics.js"></script>
</body>
```

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/calendar.html public/login.html public/dashboard.html public/terms.html public/cancellation.html public/privacy.html
git commit -m "feat(analytics): add beacon script to all public pages"
```

---

## Task 5: Admin panel — Traffic tab

**Files:**
- Modify: `public/admin.html`

The `admin.html` React app currently has a single flat view (`AdminApp`, lines 400–526). We need to:
1. Add `TrafficDashboard` component (before `AdminApp`)
2. Add `activeTab` state to `AdminApp`
3. Add a tab bar in the `<main>` section
4. Conditionally render events list OR `<TrafficDashboard />`

- [ ] **Step 1: Add `TrafficDashboard` component**

Insert the following immediately before the `// ─── Admin App ───` comment (line 399 in the current file):

```jsx
// ─── Traffic Dashboard ────────────────────────────────────────
const PAGE_LABELS = {
  home: 'דף הבית', calendar: 'לוח אירועים', login: 'כניסה',
  dashboard: 'האזור האישי', terms: 'תקנון', cancellation: 'ביטולים', privacy: 'פרטיות',
};

function StatCard({ label, sessions, views }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold text-gray-800">{sessions ?? 0}</div>
      <div className="text-xs text-gray-400">מבקרים</div>
      <div className="text-sm text-gray-500 mt-1">{views ?? 0} צפיות</div>
    </div>
  );
}

function TrafficDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    apiFetch('/analytics/summary')
      .then(setData)
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-20"><div className="spinner"></div></div>;
  if (err)     return <div className="text-center py-20 text-red-400 text-sm">{err}</div>;
  if (!data)   return null;

  const maxHourly = Math.max(...data.hourly_today.map(h => h.sessions), 1);

  return (
    <div>
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="היום"              sessions={data.today?.sessions}    views={data.today?.views} />
        <StatCard label="שבוע אחרון"        sessions={data.week?.sessions}     views={data.week?.views} />
        <StatCard label="30 יום אחרונים"    sessions={data.month?.sessions}    views={data.month?.views} />
        <StatCard label={'סה"כ'}            sessions={data.all_time?.sessions} views={data.all_time?.views} />
      </div>

      {/* Hourly bar chart */}
      {data.hourly_today.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4">מבקרים לפי שעה — היום</h3>
          <div className="flex items-end gap-0.5 h-20">
            {Array.from({ length: 24 }, (_, i) => {
              const h = String(i).padStart(2, '0');
              const d = data.hourly_today.find(x => x.hour === h);
              const pct = d ? (d.sessions / maxHourly) * 100 : 0;
              return (
                <div key={h} className="flex-1 flex flex-col items-center gap-1" title={`${h}:00 — ${d ? d.sessions : 0} מבקרים`}>
                  <div className="w-full rounded-sm transition-all" style={{ height: `${Math.max(pct, pct > 0 ? 4 : 0)}%`, backgroundColor: '#4E7772', minHeight: pct > 0 ? '2px' : '0' }}></div>
                  {i % 6 === 0 && <span className="text-gray-300" style={{fontSize:'9px'}}>{h}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Top pages */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h3 className="text-sm font-bold text-gray-700 mb-4">עמודים פופולריים (30 יום)</h3>
          {data.top_pages.length === 0
            ? <p className="text-sm text-gray-400">אין נתונים עדיין</p>
            : <div className="space-y-1">
                {data.top_pages.map(p => (
                  <div key={p.page} className="flex justify-between items-center py-1.5 border-b border-gray-50 last:border-0">
                    <span className="text-sm text-gray-700">{PAGE_LABELS[p.page] || p.page}</span>
                    <div className="flex gap-3 text-xs text-gray-400">
                      <span className="font-semibold text-gray-600">{p.sessions} מבקרים</span>
                      <span>|</span>
                      <span>{p.views} צפיות</span>
                    </div>
                  </div>
                ))}
              </div>
          }
        </div>

        {/* Top countries */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h3 className="text-sm font-bold text-gray-700 mb-4">מדינות (30 יום)</h3>
          {data.top_countries.length === 0
            ? <p className="text-sm text-gray-400">אין נתונים עדיין</p>
            : <div className="space-y-1">
                {data.top_countries.map(row => (
                  <div key={row.country} className="flex justify-between items-center py-1.5 border-b border-gray-50 last:border-0">
                    <span className="text-sm text-gray-700">{row.country}</span>
                    <span className="text-xs font-semibold text-gray-600">{row.sessions} מבקרים</span>
                  </div>
                ))}
              </div>
          }
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `activeTab` state to `AdminApp`**

In `AdminApp`, find this line (around line 406):
```js
  const [viewParticipants, setViewParticipants] = useState(null);
```
Add after it:
```js
  const [activeTab, setActiveTab] = useState('events');
```

- [ ] **Step 3: Add tab bar + conditional render in `<main>`**

Find this block (around line 458):
```jsx
      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Action bar */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-bold">כל האירועים ({events.length})</h2>
          <button onClick={() => { setEditEvent(null); setShowForm(true); }}
            className="px-5 py-2.5 bg-primary text-white rounded-lg font-semibold hover:bg-blue-600 transition">
            + אירוע חדש
          </button>
        </div>

        {loading ? (
```

Replace with:
```jsx
      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Tab bar */}
        <div className="flex gap-6 mb-6 border-b border-gray-100">
          <button onClick={() => setActiveTab('events')}
            className={`pb-2 text-sm font-semibold border-b-2 transition ${activeTab === 'events' ? 'border-primary text-primary' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
            אירועים ({events.length})
          </button>
          <button onClick={() => setActiveTab('traffic')}
            className={`pb-2 text-sm font-semibold border-b-2 transition ${activeTab === 'traffic' ? 'border-primary text-primary' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
            תנועה
          </button>
        </div>

        {activeTab === 'traffic' ? (
          <TrafficDashboard />
        ) : (
          <>
        {/* Action bar */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-bold">כל האירועים ({events.length})</h2>
          <button onClick={() => { setEditEvent(null); setShowForm(true); }}
            className="px-5 py-2.5 bg-primary text-white rounded-lg font-semibold hover:bg-blue-600 transition">
            + אירוע חדש
          </button>
        </div>

        {loading ? (
```

Then find the end of the events list section, just before `</main>`. The current last line before `</main>` is:
```jsx
        )}
      </main>
```

Change it to close the new conditional wrapper:
```jsx
        )}
          </>
        )}
      </main>
```

- [ ] **Step 4: Commit**

```bash
git add public/admin.html
git commit -m "feat(analytics): add Traffic tab to admin panel"
```

---

## Task 6: Push to staging and verify

- [ ] **Step 1: Push to staging**

```bash
git push origin staging
```

Wait ~30 seconds for the GitHub Actions deploy to complete.

- [ ] **Step 2: Seed a few test hits via curl (staging endpoint)**

```bash
# Simulate 3 page views (the beacon is prod-only, so seed manually)
curl -s -X POST https://staging.ofarim.pages.dev/api/analytics/hit \
  -H 'Content-Type: application/json' \
  -d '{"page":"home","session_id":"test-session-1","referrer":""}'

curl -s -X POST https://staging.ofarim.pages.dev/api/analytics/hit \
  -H 'Content-Type: application/json' \
  -d '{"page":"calendar","session_id":"test-session-1","referrer":"google.com"}'

curl -s -X POST https://staging.ofarim.pages.dev/api/analytics/hit \
  -H 'Content-Type: application/json' \
  -d '{"page":"home","session_id":"test-session-2","referrer":""}'
```

Expected each: `{"ok":true}`

- [ ] **Step 3: Get an admin token and verify the summary**

```bash
TOKEN=$(curl -s -X POST https://staging.ofarim.pages.dev/api/staging/admin-login \
  -H 'X-Staging-Token: staging-admin-sandbox-token-v3p8' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s https://staging.ofarim.pages.dev/api/analytics/summary \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: JSON with `today.sessions: 2`, `top_pages` showing `home` and `calendar`.

- [ ] **Step 4: Open `staging.ofarim.pages.dev/admin` in a browser, log in, click "תנועה" tab**

Confirm: stat cards show the seeded data, top pages list shows `home` and `calendar`.

---

## Task 7: Apply schema to production D1 (after staging sign-off)

> **Do not run until staging is verified.**

- [ ] **Step 1: Apply migration to prod**

```bash
wrangler d1 execute ofarim --remote --command "
CREATE TABLE IF NOT EXISTS page_views (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page        TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  country     TEXT,
  referrer    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created_at ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_session    ON page_views(session_id);
"
```

Expected: success (3 commands executed)

- [ ] **Step 2: Open PR and merge to main**

```bash
gh pr create --title "feat(analytics): visitor traffic tracking + admin Traffic tab" \
  --body "$(cat <<'EOF'
## Summary
- New \`page_views\` D1 table (page, session_id, country, referrer, created_at)
- \`POST /api/analytics/hit\` — anonymous beacon endpoint, no auth
- \`GET /api/analytics/summary\` — admin-only aggregated stats (today/week/month/all-time, top pages, hourly chart, top countries)
- \`public/analytics.js\` — production-only beacon (hostname-gated, sessionStorage dedup)
- Beacon added to 7 public HTML pages
- Admin panel: new "תנועה" tab with stat cards, hourly bar chart, top pages, top countries

## Test plan
- [ ] Seed hits on staging via curl, verify Traffic tab shows correct counts
- [ ] Confirm beacon does NOT fire on staging (check Network tab — no /api/analytics/hit call)
- [ ] Confirm Traffic tab loads with empty state if no data
- [ ] Merge, verify prod D1 has the table, visit prod site, check admin Traffic tab

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then merge: `gh pr merge --squash`

---

## Self-Review

**Spec coverage:**
- ✅ Visitor tracking without booking/signup
- ✅ Traffic data in admin control panel
- ✅ Production-only beacon (staging unaffected)
- ✅ No PII stored (session_id is random, country is aggregate)
- ✅ Stat cards: today / week / 30d / all-time
- ✅ Hourly breakdown for today
- ✅ Top pages (30d)
- ✅ Top countries (30d)

**Placeholder scan:** None found — all code blocks are complete and runnable.

**Type consistency:** `data.top_pages`, `data.hourly_today`, `data.top_countries` used in `TrafficDashboard` match the keys returned by the `/analytics/summary` route exactly.
