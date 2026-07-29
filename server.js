require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '55 23 * * *';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const STUDENTS_PATH = path.join(__dirname, 'students.json');
const COMMITS_PATH = path.join(__dirname, 'data', 'commits.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- File helpers ----------

function loadStudents() {
  const students = JSON.parse(fs.readFileSync(STUDENTS_PATH, 'utf-8'));

  // Backfill id/class/section for rosters created before these fields existed.
  let needsSave = false;
  for (const s of students) {
    const normalizedOwner = normalizeGitHubRef(s.owner);
    const normalizedRepo = normalizeGitHubRef(s.repo);
    if (s.owner !== normalizedOwner) { s.owner = normalizedOwner; needsSave = true; }
    if (s.repo !== normalizedRepo) { s.repo = normalizedRepo; needsSave = true; }
    if (!s.id) { s.id = makeId(); needsSave = true; }
    if (!s.class) { s.class = 'Unassigned'; needsSave = true; }
    if (!s.section) { s.section = 'Unassigned'; needsSave = true; }
  }
  if (needsSave) saveStudents(students);

  return students;
}

function saveStudents(data) {
  fs.writeFileSync(STUDENTS_PATH, JSON.stringify(data, null, 2));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeGitHubRef(value) {
  const raw = String(value || '').trim().replace(/\.git$/i, '');
  if (!raw) return '';

  try {
    const parsed = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    // Fall through to the raw value below.
  }

  return raw;
}

function loadCommits() {
  if (!fs.existsSync(COMMITS_PATH)) return {};
  return JSON.parse(fs.readFileSync(COMMITS_PATH, 'utf-8'));
}

function saveCommits(data) {
  fs.writeFileSync(COMMITS_PATH, JSON.stringify(data, null, 2));
}

// ---------- Timezone-aware day boundaries ----------

function getTimezoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? '00' : map.hour;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(hour), Number(map.minute), Number(map.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

function localDayRangeUTC(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const noonGuessUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMin = getTimezoneOffsetMinutes(noonGuessUTC, timeZone);
  const startUTC = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000);
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
  return { since: startUTC.toISOString(), until: endUTC.toISOString() };
}

function todayLocalDateStr(timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return dtf.format(new Date());
}

// ---------- GitHub API ----------

async function fetchCommitCount(owner, repo, dateStr) {
  owner = normalizeGitHubRef(owner);
  repo = normalizeGitHubRef(repo);
  const { since, until } = localDayRangeUTC(dateStr, TIMEZONE);
  let page = 1;
  let total = 0;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&until=${until}&per_page=100&page=${page}`;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'class-commit-tracker'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

    const res = await fetch(url, { headers });

    if (res.status === 409) return 0; // empty repo, no commits at all
    if (res.status === 404) return { error: 'repo not found (check owner/repo or token access for private repos)' };
    if (res.status === 401) return { error: 'bad or missing GitHub token' };
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      return { error: `rate limited (remaining: ${remaining ?? 'unknown'})` };
    }
    if (!res.ok) return { error: `GitHub API error ${res.status}` };

    const commits = await res.json();
    total += commits.length;
    if (commits.length < 100) break;
    page += 1;
  }

  return total;
}

async function trackDay(dateStr) {
  const students = loadStudents();
  const commits = loadCommits();
  if (!commits[dateStr]) commits[dateStr] = {};

  for (const student of students) {
    const result = await fetchCommitCount(student.owner, student.repo, dateStr);
    commits[dateStr][student.id] = result;
  }

  saveCommits(commits);
  return commits[dateStr];
}

// ---------- Routes ----------

app.get('/api/students', (req, res) => {
  res.json(loadStudents());
});

// Add a new student: { name, owner, repo, class, section }
app.post('/api/students', (req, res) => {
  const { name, owner, repo, class: className, section } = req.body || {};

  if (!name || !owner || !repo) {
    return res.status(400).json({ error: 'name, owner, and repo are required' });
  }

  const students = loadStudents();

  const duplicate = students.some(
    s => normalizeGitHubRef(s.owner).toLowerCase() === normalizeGitHubRef(owner).toLowerCase() &&
         normalizeGitHubRef(s.repo).toLowerCase() === normalizeGitHubRef(repo).toLowerCase()
  );
  if (duplicate) {
    return res.status(409).json({ error: 'a student with that owner/repo is already on the roster' });
  }

  const student = {
    id: makeId(),
    name: String(name).trim(),
    owner: normalizeGitHubRef(owner),
    repo: normalizeGitHubRef(repo),
    class: className ? String(className).trim() : 'Unassigned',
    section: section ? String(section).trim() : 'Unassigned'
  };

  students.push(student);
  saveStudents(students);
  res.status(201).json(student);
});

// Remove a student from the roster (their historical commit data is kept)
app.delete('/api/students/:id', (req, res) => {
  const students = loadStudents();
  const next = students.filter(s => s.id !== req.params.id);

  if (next.length === students.length) {
    return res.status(404).json({ error: 'student not found' });
  }

  saveStudents(next);
  res.json({ deleted: req.params.id });
});

app.get('/api/commits', (req, res) => {
  res.json(loadCommits());
});

// Trigger a fetch for a given date (defaults to "today" in TIMEZONE)
app.post('/api/track', async (req, res) => {
  const dateStr = req.query.date || todayLocalDateStr(TIMEZONE);
  try {
    const dayData = await trackDay(dateStr);
    res.json({ date: dateStr, data: dayData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ timezone: TIMEZONE, cronSchedule: CRON_SCHEDULE, hasToken: Boolean(GITHUB_TOKEN) });
});

// ---------- Scheduled auto-tracking ----------

cron.schedule(CRON_SCHEDULE, async () => {
  const dateStr = todayLocalDateStr(TIMEZONE);
  console.log(`[cron] tracking commits for ${dateStr}...`);
  try {
    await trackDay(dateStr);
    console.log(`[cron] done for ${dateStr}`);
  } catch (err) {
    console.error(`[cron] failed:`, err.message);
  }
}, { timezone: TIMEZONE });

app.listen(PORT, () => {
  console.log(`Commit tracker running at http://localhost:${PORT}`);
  console.log(`Timezone: ${TIMEZONE} | Cron: "${CRON_SCHEDULE}" | GitHub token set: ${Boolean(GITHUB_TOKEN)}`);
});
