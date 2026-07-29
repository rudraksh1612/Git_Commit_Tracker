# Commit Ledger

Tracks daily GitHub commit counts for a fixed list of students, stores them in a
JSON file, and shows them on a dashboard. Runs automatically on a daily schedule,
and can also be triggered manually.

## 1. Install

```bash
cd commit-tracker
npm install
```

## 2. Configure

Copy the env template and fill it in:

```bash
cp .env.example .env
```

- `GITHUB_TOKEN` — a GitHub Personal Access Token with repo read access.
  Without one you're limited to 60 API requests/hour, which is easy to hit
  with more than a few students. [Create one here](https://github.com/settings/tokens)
  (classic token, "repo" scope is enough; use fine-grained + read-only if you prefer).
- `TIMEZONE` — IANA timezone (e.g. `Asia/Kolkata`) used to define day boundaries,
  so a commit at 11:58pm counts for the right day.
- `CRON_SCHEDULE` — when the daily auto-track runs, in standard cron syntax,
  evaluated in `TIMEZONE`. Default is `55 23 * * *` (11:55pm every day).

You can seed **`students.json`** by hand with your class roster, or just use
the **Add student** form on the dashboard once the server's running — either
way ends up here:

```json
[
  { "id": "s1a1", "name": "Alice Sharma", "owner": "alice-gh", "repo": "cs101-project", "class": "10", "section": "A" }
]
```

`owner` is the GitHub username/org, `repo` is the repository name (from
`github.com/OWNER/REPO`). `class`/`section` are free-text labels used to
group students on the dashboard (e.g. `class: "10"`, `section: "A"`) — leave
them blank and the student lands in "Unassigned". If a student's repo is
private, they need to either add you as a collaborator (so your token can
read it) or the token must belong to an org member with access.

If you already had a `students.json` from before this feature (no `id`/
`class`/`section` fields), it's auto-migrated the first time the server
loads it — ids get generated and missing class/section default to
"Unassigned".

## 3. Run

```bash
npm start
```

Open `http://localhost:3000`. The dashboard shows:
- **Track today's commits** button — fetches right now, on demand
- **Add student** form — register a student's name, GitHub owner/repo, class, and section without touching JSON by hand
- A **Section** filter — narrow everything below to one class/section, or view all
- Summary stats (commits today, all-time, most active student, days tracked) — scoped to the current filter
- A 14-day ledger heatmap, grouped by class/section, one row per student, with a "×" to remove a student from the roster (their history stays in `data/commits.json`)
- A trend chart of total daily commits, scoped to the current filter

> **Heads up on `CRON_SCHEDULE = "* * * * *"` (every minute):** the tracker
> re-fetches **every** student's commit count on each run. With N students
> that's N GitHub API calls per minute — you'll burn through even an
> authenticated token's 5,000/hour budget fast once you have more than a
> handful of students, and each student's ledger cell will just show a
> "rate limited" error until the window resets. Something like `*/15 * * * *`
> (every 15 min) or `0 * * * *` (hourly) is usually plenty for daily counts.

The server also auto-tracks once a day on the `CRON_SCHEDULE` you set, as
long as the process keeps running (use `pm2`, a systemd service, or a host
like Render/Railway/a small VPS to keep it alive continuously).

## How "commits in a day" is counted

For each student's repo, the app calls GitHub's
`GET /repos/{owner}/{repo}/commits?since=...&until=...` for the 24-hour
window of that calendar day in your configured `TIMEZONE`, and counts all
commits returned (paginated automatically). This counts all commits pushed
to the default branch in that window, regardless of author — if you want
per-author counts (e.g. a shared team repo), that's a small extension to
`fetchCommitCount` in `server.js` (filter by `commit.author.email` or GitHub
username).

## Data storage

Raw counts live in `data/commits.json`, shaped like:

```json
{
  "2026-07-28": {
    "Alice Sharma": 4,
    "Bob Kumar": { "error": "repo not found (check owner/repo or token access for private repos)" }
  }
}
```

An `error` object instead of a number means that student's fetch failed that
day (bad repo name, no access, or rate limit) — check the message and
re-track. This file is plain JSON, so it's easy to back up, diff, or import
into a spreadsheet later.

## API endpoints

- `GET /api/students` — the roster
- `POST /api/students` — add a student, body `{ name, owner, repo, class, section }` (`class`/`section` optional)
- `DELETE /api/students/:id` — remove a student from the roster
- `GET /api/commits` — the full stored dataset (keyed by student `id`, not name)
- `POST /api/track?date=YYYY-MM-DD` — fetch counts for a date (defaults to today)
- `GET /api/config` — current timezone/cron/token status
