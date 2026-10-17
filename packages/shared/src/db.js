// Thin wrapper over Node's built-in SQLite (node:sqlite, Node >= 22.5).
// Zero native dependencies: customers can `npm install` on any platform.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Open (or create) a database and apply ordered migrations exactly once.
 * @param {string} path  file path or ':memory:'
 * @param {string[]} migrations  SQL strings, applied in order, tracked in _migrations
 */
export function openDatabase(path, migrations) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM _migrations').all().map((r) => r.id));
  migrations.forEach((sql, i) => {
    if (applied.has(i)) return;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(i, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
