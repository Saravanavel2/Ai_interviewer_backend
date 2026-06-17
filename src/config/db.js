const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const dbPath = path.resolve(__dirname, '../../database.sqlite');
let db = null;

async function getDb() {
  if (db) return db;

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.run('PRAGMA foreign_keys = ON');

  // Initialize Schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      target_role TEXT NOT NULL,
      target_company TEXT NOT NULL,
      api_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS resume_sections (
      id TEXT PRIMARY KEY,
      resume_id TEXT NOT NULL,
      section_type TEXT NOT NULL, -- e.g., 'Summary', 'Technical Skills', 'Certifications', 'Projects', 'Internships/Experience', 'Education'
      extracted_text TEXT NOT NULL,
      improved_version TEXT,
      FOREIGN KEY (resume_id) REFERENCES resumes (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interview_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_type TEXT DEFAULT 'full',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      question_text TEXT NOT NULL,
      topic TEXT,
      difficulty TEXT,
      is_technical INTEGER DEFAULT 0, -- 1 for technical round, 0 for resume round
      section_name TEXT,              -- e.g., 'Technical Skills', 'Projects' (null for general technical round)
      FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      transcript TEXT,
      audio_url TEXT,
      FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS technical_scores (
      id TEXT PRIMARY KEY,
      answer_id TEXT NOT NULL,
      correctness_score INTEGER NOT NULL,
      FOREIGN KEY (answer_id) REFERENCES answers (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS communication_scores (
      id TEXT PRIMARY KEY,
      answer_id TEXT NOT NULL,
      clarity INTEGER NOT NULL,
      structure INTEGER NOT NULL,
      confidence INTEGER NOT NULL,
      conciseness INTEGER NOT NULL,
      overall INTEGER NOT NULL,
      FOREIGN KEY (answer_id) REFERENCES answers (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feedbacks (
      id TEXT PRIMARY KEY,
      answer_id TEXT NOT NULL,
      ai_feedback TEXT NOT NULL,
      FOREIGN KEY (answer_id) REFERENCES answers (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS final_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      resume_summary TEXT,
      technical_summary TEXT,
      communication_trend TEXT, -- JSON string or comma-separated scores
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS action_plans (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      priority TEXT NOT NULL, -- 'High', 'Medium', 'Low'
      FOREIGN KEY (report_id) REFERENCES final_reports (id) ON DELETE CASCADE
    );
  `);

  // Run dynamic migrations to add new columns to existing database files
  try {
    await db.run('ALTER TABLE final_reports ADD COLUMN session_id TEXT');
  } catch (e) {
    // Column already exists
  }
  try {
    await db.run('ALTER TABLE answers ADD COLUMN coding_language TEXT');
  } catch (e) {
    // Column already exists
  }
  try {
    await db.run('ALTER TABLE answers ADD COLUMN compilation_status TEXT');
  } catch (e) {
    // Column already exists
  }
  try {
    await db.run('ALTER TABLE resumes ADD COLUMN ats_score INTEGER');
  } catch (e) {
    // Column already exists
  }
  try {
    await db.run('ALTER TABLE resumes ADD COLUMN ats_feedback TEXT');
  } catch (e) {
    // Column already exists
  }

  console.log('SQLite database initialized successfully at', dbPath);
  return db;
}

module.exports = {
  getDb
};
