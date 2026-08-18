# Commit Tracker

Tracks daily GitHub commit counts for a class roster collected via a Google
Form, synced into MongoDB, and shown on a dashboard with a section-by-section
leaderboard, a heatmap ledger, and a trend chart.

GitHub and the Sheet are refreshed when
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


## Install and configure

```bash
cd commit-tracker
npm install
cp .env.example .env
```


## Run

```bash
npm start
```


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


## API endpoints

- `GET /api/students` — current roster
- `DELETE /api/students/:id` — remove a student (keeps their commit history)
- `POST /api/students/sync` — pull new rows from the Google Sheet now
- `GET /api/commits` — full commit dataset, shaped as `{ date: { studentId: count | {error} } }`
- `GET /api/leaderboard` — totals per student, grouped by class/section, sorted descending
- `POST /api/track?date=YYYY-MM-DD` — fetch GitHub commit counts for a date (defaults to today)
- `POST /api/refresh` — does both of the above in one call (sync roster, then track today); this is what the dashboard calls on page load
- `GET /api/config` — current timezone/token/sheet status
