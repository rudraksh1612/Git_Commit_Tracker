const { parse } = require('csv-parse/sync');
const { getDb } = require('./db');

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';

// Matches a Google Form response sheet header to one of our fields, tolerating
// slightly different wording/casing (e.g. "Student Name" or "Full Name").
function matchHeader(header, candidates) {
  const h = header.trim().toLowerCase();
  return candidates.some(c => h.includes(c));
}

function mapRow(row, headers) {
  const get = (candidates) => {
    for (let i = 0; i < headers.length; i++) {
      if (matchHeader(headers[i], candidates)) return (row[i] || '').trim();
    }
    return '';
  };

  return {
    name: get(['name']),
    owner: get(['owner', 'github username', 'github org', 'github user']),
    repo: get(['repo']),
    class: get(['class', 'grade']),
    section: get(['section'])
  };
}

async function fetchSheetRows() {
  if (!SHEET_CSV_URL) {
    throw new Error('SHEET_CSV_URL is not set in .env — see README for how to publish your sheet as CSV.');
  }

  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) {
    throw new Error(`could not fetch sheet CSV (HTTP ${res.status}) — check SHEET_CSV_URL is a public "publish to web" CSV link`);
  }

  const csvText = await res.text();
  const records = parse(csvText, { skip_empty_lines: true });
  if (records.length === 0) return [];

  const headers = records[0];
  const rows = records.slice(1).map(r => mapRow(r, headers));

  return rows.filter(r => r.owner && r.repo); // owner+repo are the only hard requirements
}

// Upserts each valid row into the students collection, keyed by owner+repo.
// Returns a summary of what happened.
async function syncRoster() {
  const db = await getDb();
  const students = db.collection('students');
  const rows = await fetchSheetRows();

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.name) { skipped++; continue; }

    const ownerLower = row.owner.toLowerCase();
    const repoLower = row.repo.toLowerCase();

    const result = await students.updateOne(
      { ownerLower, repoLower },
      {
        $set: {
          name: row.name,
          owner: row.owner,
          repo: row.repo,
          class: row.class || 'Unassigned',
          section: row.section || 'Unassigned',
          ownerLower,
          repoLower,
          source: 'google_form',
          syncedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) added++;
    else if (result.modifiedCount > 0) updated++;
  }

  return { totalRows: rows.length, added, updated, skipped, unchanged: rows.length - added - updated - skipped };
}

module.exports = { syncRoster };
