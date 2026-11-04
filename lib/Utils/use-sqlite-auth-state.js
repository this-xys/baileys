import { proto } from "../../WAProto/index.js";
import { initAuthCreds } from "./auth-utils.js";
import { BufferJSON } from "./generics.js";

async function loadBetterSqlite3() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default ?? mod;
  } catch (err) {
    const helpful = new Error("`better-sqlite3` is required for `useSqliteAuthState`. Install it as a peer dependency: `npm install better-sqlite3` (or `yarn add better-sqlite3`).");
    helpful.cause = err;
    throw helpful;
  }
}

const CREDS_ROW_KEY = "__creds__";
const CREATE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS creds (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signal_keys (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, id));
CREATE INDEX IF NOT EXISTS signal_keys_type_idx ON signal_keys(type);`;
const MIGRATIONS = [{ id: "0001_init", sql: CREATE_SCHEMA_SQL }];
function ensureMigrationsTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS wa_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
}

function runMigrations(db) {
  ensureMigrationsTable(db);
  const applied = new Set(db.prepare("SELECT id FROM wa_migrations").all().map((r) => r.id));
  const insertMigration = db.prepare("INSERT INTO wa_migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.id, Date.now());
    });
    tx();
  }
}

async function useSqliteAuthState(opts) {
  let db;
  const ownsDb = !("database" in opts);
  if (!ownsDb) {
    db = opts.database;
  } else {
    const Database = await loadBetterSqlite3();
    db = new Database(opts.dbPath);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -4096");
  db.pragma("busy_timeout = 5000");
  db.pragma("mmap_size = 0");
  runMigrations(db);
  let closed = false;
  const stmts = {
    credsSelect: db.prepare("SELECT value FROM creds WHERE key = ?"),
    credsUpsert: db.prepare("INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    keySelect: db.prepare("SELECT value FROM signal_keys WHERE type = ? AND id = ?"),
    keyUpsert: db.prepare("INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value"),
    keyDelete: db.prepare("DELETE FROM signal_keys WHERE type = ? AND id = ?"),
    keyListIds: db.prepare("SELECT id FROM signal_keys WHERE type = ? ORDER BY id"),
    keyList: db.prepare("SELECT id, value FROM signal_keys WHERE type = ? ORDER BY id"),
    clearKeys: db.prepare("DELETE FROM signal_keys")
  };
  const initialRow = stmts.credsSelect.get(CREDS_ROW_KEY);
  const creds = initialRow ? JSON.parse(initialRow.value, BufferJSON.reviver) : initAuthCreds();
  let lastPersistedCreds = initialRow ? initialRow.value : undefined;
  const persistCreds = (creds2) => {
    if (closed || !db.open) return;
    const json = JSON.stringify(creds2, BufferJSON.replacer);
    if (json === lastPersistedCreds) return;
    stmts.credsUpsert.run(CREDS_ROW_KEY, json);
    lastPersistedCreds = json;
  };
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (closed || !db.open) return data;
          for (const id of ids) {
            const row = stmts.keySelect.get(type, id);
            if (row) {
              let value = JSON.parse(row.value, BufferJSON.reviver);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          if (closed || !db.open) return;
          const writeTx = db.transaction(() => {
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                if (value) {
                  stmts.keyUpsert.run(category, id, JSON.stringify(value, BufferJSON.replacer));
                } else {
                  stmts.keyDelete.run(category, id);
                }
              }
            }
          });
          writeTx();
        },
        async *list(type) {
          if (closed || !db.open) return;
          for (const row of stmts.keyList.all(type)) {
            let value = JSON.parse(row.value, BufferJSON.reviver);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            yield [row.id, value];
          }
        },
        async *listIds(type) {
          if (closed || !db.open) return;
          for (const row of stmts.keyListIds.all(type)) {
            yield row.id;
          }
        }
      }
    },
    saveCreds: () => {
      persistCreds(creds);
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.pragma("wal_checkpoint(PASSIVE)");
      } catch {}
      if (ownsDb) {
        try {
          db.close();
        } catch {}
      }
    }
  };
}

export { useSqliteAuthState };
