const HEAT_HEX = {
  0: '#24392C',
  1: '#3F6B4C',
  2: '#5FA06B',
  3: '#86D18F',
  4: '#C6F1B8'
};

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

async function loadAll() {
  const [config, students, commits] = await Promise.all([
    fetch('/api/config').then(r => r.json()),
    fetch('/api/students').then(r => r.json()),
    fetch('/api/commits').then(r => r.json())
  ]);
  return { config, students, commits };
}

function renderBadges(config) {
  const el = document.getElementById('configBadges');
  el.innerHTML = `
    <span class="badge">tz: <b>${config.timezone}</b></span>
    <span class="badge">cron: <b>${config.cronSchedule}</b></span>
    <span class="badge ${config.hasToken ? '' : 'warn'}">token: <b>${config.hasToken ? 'set' : 'missing'}</b></span>
  `;
}

function renderStats(students, commits) {
  const dates = Object.keys(commits).sort();
  const today = todayInTZ(window.__tz || 'UTC');

  let totalToday = 0;
  if (commits[today]) {
    for (const v of Object.values(commits[today])) {
      if (typeof v === 'number') totalToday += v;
    }
  }

  let totalAllTime = 0;
  const perStudent = {};
  students.forEach(s => perStudent[s.name] = 0);

  for (const date of dates) {
    for (const [name, v] of Object.entries(commits[date])) {
      if (typeof v === 'number') {
        totalAllTime += v;
        if (name in perStudent) perStudent[name] += v;
      }
    }
  }

  let topStudent = '—';
  let topCount = -1;
  for (const [name, count] of Object.entries(perStudent)) {
    if (count > topCount) { topCount = count; topStudent = name; }
  }

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
      <div class="value small">${topStudent}${topCount >= 0 ? ' · ' + topCount : ''}</div>
    </div>
    <div class="stat">
      <div class="label">Days tracked</div>
      <div class="value">${dates.length}</div>
    </div>
  `;
}

function renderLedger(students, commits, tz) {
  const today = todayInTZ(tz);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDaysToDateStr(today, -i));

  document.getElementById('ledgerRange').textContent = `${shortLabel(days[0])} → ${shortLabel(days[days.length - 1])}`;

  const thead = document.querySelector('#ledgerTable thead');
  const tbody = document.querySelector('#ledgerTable tbody');

  thead.innerHTML = `<tr><th class="name-head">Student</th>${days.map(d => `<th>${shortLabel(d)}</th>`).join('')}</tr>`;

  tbody.innerHTML = students.map(s => {
    const cells = days.map(date => {
      const entry = commits[date] ? commits[date][s.name] : undefined;
      if (entry === undefined) {
        return `<td><span class="cell-square na">–</span></td>`;
      }
      if (typeof entry === 'object' && entry.error) {
        return `<td><span class="cell-square err" title="${entry.error}">!</span></td>`;
      }
      const level = heatLevel(entry);
      return `<td><span class="cell-square" style="background:${HEAT_HEX[level]}">${entry}</span></td>`;
    }).join('');
    return `<tr><td class="name-cell">${s.name}</td>${cells}</tr>`;
  }).join('');
}

let trendChart = null;

function renderTrend(commits) {
  const dates = Object.keys(commits).sort();
  const totals = dates.map(date => {
    let sum = 0;
    for (const v of Object.values(commits[date])) if (typeof v === 'number') sum += v;
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

async function refresh() {
  const { config, students, commits } = await loadAll();
  window.__tz = config.timezone;
  renderBadges(config);
  renderStats(students, commits);
  renderLedger(students, commits, config.timezone);
  renderTrend(commits);
}

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
    await refresh();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

refresh();
