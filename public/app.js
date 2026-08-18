const HEAT_HEX = {
  0: '#24392C',
  1: '#3F6B4C',
  2: '#5FA06B',
  3: '#86D18F',
  4: '#C6F1B8'
};

const MEDALS = ['🥇', '🥈', '🥉'];

let allStudents = [];
let allCommits = {};
let currentTZ = 'UTC';
let currentFilter = 'all';

function heatLevel(n) {
  if (n === 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 9) return 3;
  return 4;
}

function addDaysToDateStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function todayInTZ(tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return dtf.format(new Date());
}

function shortLabel(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${m}/${d}`;
}

function groupKey(s) {
  return `${s.class || 'Unassigned'} - ${s.section || 'Unassigned'}`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

async function loadAll() {
  const [config, students, commits, leaderboard] = await Promise.all([
    fetch('/api/config').then(r => r.json()),
    fetch('/api/students').then(r => r.json()),
    fetch('/api/commits').then(r => r.json()),
    fetch('/api/leaderboard').then(r => r.json())
  ]);
  return { config, students, commits, leaderboard };
}

function renderBadges(config) {
  const el = document.getElementById('configBadges');
  el.innerHTML = `
    <span class="badge">tz: <b>${config.timezone}</b></span>
    <span class="badge ${config.hasSheetUrl ? '' : 'warn'}">sheet sync: <b>${config.hasSheetUrl ? 'configured' : 'not configured'}</b></span>
    <span class="badge ${config.hasToken ? '' : 'warn'}">token: <b>${config.hasToken ? 'set' : 'missing'}</b></span>
  `;
}

function populateFilter(students) {
  const select = document.getElementById('sectionFilter');
  const groups = [...new Set(students.map(groupKey))].sort();
  const prev = select.value || 'all';

  select.innerHTML = `<option value="all">All</option>` +
    groups.map(g => `<option value="${g}">${g}</option>`).join('');

  select.value = groups.includes(prev) ? prev : 'all';
  currentFilter = select.value;
}

function filteredStudents() {
  if (currentFilter === 'all') return allStudents;
  return allStudents.filter(s => groupKey(s) === currentFilter);
}

function renderStats(students, commits) {
  const dates = Object.keys(commits).sort();
  const today = todayInTZ(currentTZ);
  const ids = new Set(students.map(s => s.id));

  let totalToday = 0;
  if (commits[today]) {
    for (const [id, v] of Object.entries(commits[today])) {
      if (ids.has(id) && typeof v === 'number') totalToday += v;
    }
  }

  let totalAllTime = 0;
  const perStudent = {};
  students.forEach(s => perStudent[s.id] = 0);

  for (const date of dates) {
    for (const [id, v] of Object.entries(commits[date])) {
      if (typeof v === 'number' && id in perStudent) {
        totalAllTime += v;
        perStudent[id] += v;
      }
    }
  }

  let topId = null;
  let topCount = -1;
  for (const [id, count] of Object.entries(perStudent)) {
    if (count > topCount) { topCount = count; topId = id; }
  }
  const topStudent = students.find(s => s.id === topId);

  const el = document.getElementById('stats');
  el.innerHTML = `
    <div class="stat">
      <div class="label">Commits today</div>
      <div class="value">${totalToday}</div>
    </div>
    <div class="stat">
      <div class="label">Commits all-time</div>
      <div class="value">${totalAllTime}</div>
    </div>
    <div class="stat">
      <div class="label">Most active</div>
      <div class="value small">${topStudent ? topStudent.name : '—'}${topCount >= 0 ? ' · ' + topCount : ''}</div>
    </div>
    <div class="stat">
      <div class="label">Days tracked</div>
      <div class="value">${dates.length}</div>
    </div>
  `;
}

function renderLeaderboard(leaderboard) {
  const el = document.getElementById('leaderboard');
  let groups = leaderboard;

  if (currentFilter !== 'all') {
    groups = groups.filter(g => g.group === currentFilter);
  }

  if (groups.length === 0) {
    el.innerHTML = `<p class="track-status">No students yet — sync from the Google Sheet to get started.</p>`;
    return;
  }

  el.innerHTML = groups.map(g => {
    const maxTotal = Math.max(1, ...g.students.map(s => s.total));
    const rows = g.students.map((s, i) => `
      <div class="lb-row">
        <span class="lb-rank">${MEDALS[i] || (i + 1)}</span>
        <span class="lb-avatar">${initials(s.name)}</span>
        <span class="lb-name">${s.name}</span>
        <span class="lb-bar-track"><span class="lb-bar-fill" style="width:${(s.total / maxTotal) * 100}%"></span></span>
        <span class="lb-count">${s.total}</span>
      </div>
    `).join('');

    return `
      <div class="lb-group">
        <div class="lb-group-head">${g.group}</div>
        ${rows}
      </div>
    `;
  }).join('');
}

async function removeStudent(id) {
  if (!confirm('Remove this student from the roster? Historical commit data is kept.')) return;
  const res = await fetch(`/api/students/${id}`, { method: 'DELETE' });
  if (res.ok) {
    await loadAndRender();
  } else {
    alert('Could not remove student.');
  }
}

function renderLedger(students, commits, tz) {
  const today = todayInTZ(tz);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDaysToDateStr(today, -i));

  document.getElementById('ledgerRange').textContent = `${shortLabel(days[0])} → ${shortLabel(days[days.length - 1])}`;

  const thead = document.querySelector('#ledgerTable thead');
  const tbody = document.querySelector('#ledgerTable tbody');

  thead.innerHTML = `<tr><th class="name-head">Student</th>${days.map(d => `<th>${shortLabel(d)}</th>`).join('')}</tr>`;

  const groups = {};
  students.forEach(s => {
    const key = groupKey(s);
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });

  const groupNames = Object.keys(groups).sort();
  let rows = '';

  for (const gname of groupNames) {
    rows += `<tr class="group-row"><td colspan="${days.length + 1}">${gname} · ${groups[gname].length} student${groups[gname].length === 1 ? '' : 's'}</td></tr>`;

    for (const s of groups[gname].sort((a, b) => a.name.localeCompare(b.name))) {
      const cells = days.map(date => {
        const entry = commits[date] ? commits[date][s.id] : undefined;
        if (entry === undefined || entry === null) {
          return `<td><span class="cell-square na">–</span></td>`;
        }
        if (typeof entry === 'object' && entry.error) {
          return `<td><span class="cell-square err" title="${entry.error}">!</span></td>`;
        }
        const level = heatLevel(entry);
        return `<td><span class="cell-square" style="background:${HEAT_HEX[level]}">${entry}</span></td>`;
      }).join('');

      // rows += `<tr><td class="name-cell">${s.name}<button class="remove-btn" data-id="${s.id}" title="Remove student">×</button></td>${cells}</tr>`;
    }
  }

  tbody.innerHTML = rows || `<tr><td colspan="${days.length + 1}">No students in this section yet.</td></tr>`;

  tbody.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeStudent(btn.dataset.id));
  });
}

let trendChart = null;
let chartWarned = false;

function renderTrend(students, commits) {
  if (typeof Chart === 'undefined') {
    if (!chartWarned) {
      chartWarned = true;
      const canvas = document.getElementById('trendChart');
      canvas.replaceWith(Object.assign(document.createElement('p'), {
        className: 'track-status',
        textContent: 'Trend chart unavailable: the Chart.js script did not load (likely blocked by an ad-blocker or network filter). Everything else on this page still works.'
      }));
    }
    return;
  }

  const ids = new Set(students.map(s => s.id));
  const dates = Object.keys(commits).sort();
  const totals = dates.map(date => {
    let sum = 0;
    for (const [id, v] of Object.entries(commits[date])) {
      if (ids.has(id) && typeof v === 'number') sum += v;
    }
    return sum;
  });

  const ctx = document.getElementById('trendChart');
  const data = {
    labels: dates.map(shortLabel),
    datasets: [{
      label: 'Total commits',
      data: totals,
      borderColor: '#E8C468',
      backgroundColor: 'rgba(232,196,104,0.12)',
      pointBackgroundColor: '#E8C468',
      tension: 0.25,
      fill: true
    }]
  };

  const options = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#9AAE9F', font: { family: 'IBM Plex Mono', size: 11 } }, grid: { color: '#35503F' } },
      y: { ticks: { color: '#9AAE9F', font: { family: 'IBM Plex Mono', size: 11 }, precision: 0 }, grid: { color: '#35503F' } }
    }
  };

  if (trendChart) {
    trendChart.data = data;
    trendChart.update();
  } else {
    trendChart = new Chart(ctx, { type: 'line', data, options });
  }
}

function render(leaderboard) {
  const students = filteredStudents();
  renderStats(students, allCommits);
  renderLeaderboard(leaderboard);
  renderLedger(students, allCommits, currentTZ);
  renderTrend(students, allCommits);
}

let lastLeaderboard = [];

async function loadAndRender() {
  const { config, students, commits, leaderboard } = await loadAll();
  currentTZ = config.timezone;
  allStudents = students;
  allCommits = commits;
  lastLeaderboard = leaderboard;
  renderBadges(config);
  populateFilter(students);
  render(leaderboard);
}

// Full page load: bring GitHub + Sheet data up to date, then display it.
// This is what replaces a background cron — reloading the page is the trigger.
async function refresh() {
  const status = document.getElementById('trackStatus');
  status.textContent = 'Updating from GitHub + Sheet…';
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const json = await res.json();
    if (json.trackError) status.textContent = `Track error: ${json.trackError}`;
    else status.textContent = `Updated for ${json.date} at ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    status.textContent = `Error updating: ${err.message}`;
  }
  await loadAndRender();
}

document.getElementById('sectionFilter').addEventListener('change', (e) => {
  currentFilter = e.target.value;
  render(lastLeaderboard);
});

document.getElementById('trackBtn').addEventListener('click', async () => {
  const btn = document.getElementById('trackBtn');
  const status = document.getElementById('trackStatus');
  btn.disabled = true;
  status.textContent = 'Fetching from GitHub…';
  try {
    const res = await fetch('/api/track', { method: 'POST' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'failed');
    status.textContent = `Tracked ${json.date} at ${new Date().toLocaleTimeString()}`;
    await loadAndRender();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  const status = document.getElementById('trackStatus');
  btn.disabled = true;
  status.textContent = 'Syncing roster from Sheet…';
  try {
    const res = await fetch('/api/students/sync', { method: 'POST' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'failed');
    status.textContent = `Synced: ${json.added} added, ${json.updated} updated, ${json.totalRows} total rows.`;
    await loadAndRender();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// No background cron and no auto-polling — reloading this page (or clicking
// Track/Sync above) is what brings the data up to date.
refresh();
