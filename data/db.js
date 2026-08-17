const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'commit_tracker';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in .env — see .env.example.');
  process.exit(1);
}

let client;
let dbPromise;

async function connect() {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  // owner+repo (lowercased) must be unique so the same repo isn't tracked twice
  await db.collection('students').createIndex(
    { ownerLower: 1, repoLower: 1 },
    { unique: true }
  );
  // one commit-count document per student per day
  await db.collection('commits').createIndex(
    { studentId: 1, date: 1 },
    { unique: true }
  );

  console.log(`Connected to MongoDB (db: ${MONGODB_DB})`);
  return db;
}

function getDb() {
  if (!dbPromise) dbPromise = connect();
  return dbPromise;
}

module.exports = { getDb };
