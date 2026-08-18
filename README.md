# Commit Ledger

Tracks daily GitHub commit counts for a class roster collected via a Google
Form, synced into MongoDB, and shown on a dashboard with a section-by-section
leaderboard, a heatmap ledger, and a trend chart.

**No background scheduler.** GitHub and the roster Sheet are refreshed when
the dashboard page loads (or reloads), and via the two buttons on the page.
Nothing runs while the page isn't open.

## How data flows

```
Google Form (students self-register)
      │  responses land in a linked Google Sheet
      ▼
Google Sheet ── "Publish to web" as CSV ──▶  SHEET_CSV_URL
      │
      ▼  (pulled in on page load, or the "Sync roster from Sheet" button)
MongoDB "students" collection
      │
      ▼  (pulled in on page load, or the "Track today's commits" button)
MongoDB "commits" collection
      │
      ▼
Dashboard: leaderboard / ledger / trend chart
```

## 1. Set up the Google Form

Create a Google Form with these fields (names don't have to match exactly —
the sync matches on keywords — but keep it close):

- **Student Name** (short answer)
- **GitHub Owner** (short answer) — their GitHub username or org
- **Repo Name** (short answer)
- **Class** (short answer or dropdown, e.g. `10`)
- **Section** (short answer or dropdown, e.g. `A`)

Open the Form's **Responses** tab → click the Sheets icon → **Create
spreadsheet**. This gives you a Sheet that fills in automatically as students
submit the form.

## 2. Publish that Sheet as CSV

In the response Sheet: **File → Share → Publish to web** → under "Link",
choose the specific sheet/tab with the responses → set format to **CSV** →
**Publish**. Copy the URL it gives you (looks like
`https://docs.google.com/spreadsheets/d/.../pub?gid=0&single=true&output=csv`).
That's your `SHEET_CSV_URL`.

This makes the sheet readable by anyone with the link (read-only, no
edit access) — that's what lets the server fetch it without OAuth.

## 3. Set up MongoDB

Easiest option: a free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register)
cluster. Create a cluster, add a database user, allow your server's IP (or
`0.0.0.0/0` for quick testing), and copy the connection string — that's your
`MONGODB_URI`. A local `mongod` works too if you'd rather run it yourself.

## 4. Install and configure

```bash
cd commit-tracker
npm install
cp .env.example .env
```

Fill in `.env`:
- `MONGODB_URI` — from step 3
- `SHEET_CSV_URL` — from step 2
- `GITHUB_TOKEN` — a GitHub token with repo read access ([create one](https://github.com/settings/tokens))
- `TIMEZONE` — e.g. `Asia/Kolkata`

## 5. Run

```bash
npm start
```

Open `http://localhost:3000`. Every time you load or reload that page, the
server syncs the roster from the Sheet and pulls today's commit counts from
GitHub before showing you anything — so a plain browser refresh is enough to
see up-to-date numbers.

## Dashboard

- **Track today's commits** — fetches commit counts from GitHub right now, without a full page reload
- **Sync roster from Sheet** — pulls any new Form submissions into MongoDB right now
- **Section filter** — narrow the leaderboard/ledger/chart to one class-section, or view all
- **Leaderboard** — ranked by all-time commits, one card per class/section, with rank, avatar initials, a bar, and the count
- **Ledger** — 14-day heatmap grouped by class/section, one row per student
- **Trend chart** — total daily commits across the (filtered) roster

Removing a student (the "×" in the ledger) deletes them from MongoDB — their
historical commit records stay, they just stop showing up in new views. If
they resubmit the Form, the next sync will re-add them (same owner/repo).

> **Reload frequency matters for your GitHub rate limit.** Each reload makes
> one GitHub API call per student. With an authenticated token that's a
> 5,000/hour budget — fine for occasional reloads with a normal class size,
> but reloading constantly (e.g. an auto-refreshing kiosk tab) with a large
> roster can burn through it. If you want unattended, scheduled updates
> instead of reload-triggered ones, that's a small change to reintroduce —
> just ask.

## How "commits in a day" is counted

For each student's repo, the app calls GitHub's
`GET /repos/{owner}/{repo}/commits?since=...&until=...` for the 24-hour
window of that calendar day in your configured `TIMEZONE`, and counts all
commits returned (paginated automatically). This counts all commits pushed
to the default branch in that window, regardless of author.

## Data model (MongoDB)

**`students`** — one document per student:
```json
{
  "_id": "ObjectId(...)",
  "name": "Alice Sharma",
  "owner": "alice-gh",
  "repo": "cs101-project",
  "class": "10",
  "section": "A",
  "ownerLower": "alice-gh",
  "repoLower": "cs101-project",
  "source": "google_form",
  "createdAt": "...",
  "syncedAt": "..."
}
```
Unique index on `{ ownerLower, repoLower }` — resubmitting the Form for the
same repo updates the existing student instead of creating a duplicate.

**`commits`** — one document per student per day:
```json
{
  "studentId": "665f...",
  "date": "2026-08-17",
  "count": 4,
  "error": null,
  "updatedAt": "..."
}
```
Unique index on `{ studentId, date }`.

## API endpoints

- `GET /api/students` — current roster
- `DELETE /api/students/:id` — remove a student (keeps their commit history)
- `POST /api/students/sync` — pull new rows from the Google Sheet now
- `GET /api/commits` — full commit dataset, shaped as `{ date: { studentId: count | {error} } }`
- `GET /api/leaderboard` — totals per student, grouped by class/section, sorted descending
- `POST /api/track?date=YYYY-MM-DD` — fetch GitHub commit counts for a date (defaults to today)
- `POST /api/refresh` — does both of the above in one call (sync roster, then track today); this is what the dashboard calls on page load
- `GET /api/config` — current timezone/token/sheet status
