require('dotenv').config();
const path = require('path');
const express = require('express');
const { ObjectId } = require('mongodb');

const { getDb } = require('./db');
const { syncRoster } = require('./sheetSync');

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    if (res.status === 409) return { count: 0, error: null }; // empty repo
    if (res.status === 404) return { count: null, error: 'repo not found (check owner/repo or token access for private repos)' };
    if (res.status === 401) return { count: null, error: 'bad or missing GitHub token' };
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      return { count: null, error: `rate limited (remaining: ${remaining ?? 'unknown'})` };
    }
    if (!res.ok) return { count: null, error: `GitHub API error ${res.status}` };

    const commits = await res.json();
    total += commits.length;
    if (commits.length < 100) break;
    page += 1;
  }

  return { count: total, error: null };
}

// ---------- Mongo-backed helpers ----------

function serializeStudent(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    owner: doc.owner,
    repo: doc.repo,
    class: doc.class || 'Unassigned',
    section: doc.section || 'Unassigned',
    source: doc.source || 'manual'
  };
}

async function loadStudents() {
  const db = await getDb();
  const docs = await db.collection('students').find({}).toArray();
  return docs.map(serializeStudent);
}

async function trackDay(dateStr) {
  const db = await getDb();
  const students = await loadStudents();
  const commits = db.collection('commits');

  const results = {};
  for (const student of students) {
    const { count, error } = await fetchCommitCount(student.owner, student.repo, dateStr);
    results[student.id] = error ? { error } : count;

    await commits.updateOne(
      { studentId: student.id, date: dateStr },
      { $set: { studentId: student.id, date: dateStr, count, error, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  return results;
}

// Reshapes flat commit documents into { date: { studentId: count | {error} } },
// matching what the dashboard expects.
async function getCommitsShaped() {
  const db = await getDb();
  const docs = await db.collection('commits').find({}).toArray();
  const shaped = {};

  for (const doc of docs) {
    if (!shaped[doc.date]) shaped[doc.date] = {};
    shaped[doc.date][doc.studentId] = doc.error ? { error: doc.error } : doc.count;
  }

  return shaped;
}

async function getLeaderboard() {
  const db = await getDb();
  const students = await loadStudents();

  const totals = await db.collection('commits').aggregate([
    { $match: { count: { $ne: null } } },
    { $group: { _id: '$studentId', total: { $sum: '$count' } } }
  ]).toArray();

  const totalByStudent = {};
  totals.forEach(t => { totalByStudent[t._id] = t.total; });

  const groups = {};
  for (const s of students) {
    const key = `${s.class} - ${s.section}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ id: s.id, name: s.name, total: totalByStudent[s.id] || 0 });
  }

  const groupNames = Object.keys(groups).sort();
  return groupNames.map(name => ({
    group: name,
    students: groups[name].sort((a, b) => b.total - a.total)
  }));
}

// ---------- Routes ----------

app.get('/api/students', async (req, res) => {
  try {
    res.json(await loadStudents());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.collection('students').deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'student not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(400).json({ error: 'invalid id' });
  }
});

// Pull the latest rows from the Google Form's response sheet into MongoDB
app.post('/api/students/sync', async (req, res) => {
  try {
    const summary = await syncRoster();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/commits', async (req, res) => {
  try {
    res.json(await getCommitsShaped());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    res.json(await getLeaderboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/track', async (req, res) => {
  const dateStr = req.query.date || todayLocalDateStr(TIMEZONE);
  try {
    const dayData = await trackDay(dateStr);
    res.json({ date: dateStr, data: dayData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-shot "bring everything up to date" call: sync roster from the Sheet
// (if configured), then fetch today's commit counts. The dashboard calls
// this on every page load/reload instead of relying on a background cron.
app.post('/api/refresh', async (req, res) => {
  const dateStr = todayLocalDateStr(TIMEZONE);
  const result = { date: dateStr };

  if (process.env.SHEET_CSV_URL) {
    try {
      result.sheetSync = await syncRoster();
    } catch (err) {
      result.sheetSyncError = err.message;
    }
  }

  try {
    result.tracked = await trackDay(dateStr);
  } catch (err) {
    result.trackError = err.message;
  }

  res.json(result);
});

app.get('/api/config', (req, res) => {
  res.json({
    timezone: TIMEZONE,
    hasToken: Boolean(GITHUB_TOKEN),
    hasSheetUrl: Boolean(process.env.SHEET_CSV_URL)
  });
});

// ---------- Boot ----------

getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Commit tracker running at http://localhost:${PORT}`);
      console.log(`Timezone: ${TIMEZONE} | GitHub token set: ${Boolean(GITHUB_TOKEN)} | Sheet sync configured: ${Boolean(process.env.SHEET_CSV_URL)}`);
      
    });
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
