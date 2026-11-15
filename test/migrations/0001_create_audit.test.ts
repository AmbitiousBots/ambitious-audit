import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMigrations } from "@ambitious/kit/db/load-migrations";
import { migrate } from "@ambitious/kit/db/migrate";
import { openDb, readUserVersion } from "@ambitious/kit/db/open-db";

const migrations = loadMigrations(join(import.meta.dirname, "..", "..", "migrations"));

test("0001_create_audit creates the audit tables at schema version 1 and keeps stored rows", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ambitious-audit-migration-"));
  const db = openDb(join(directory, "audit.sqlite"), { readonly: false });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(migrate(db, migrations.slice(0, 1)), ["0001_create_audit"]);
  assert.equal(readUserVersion(db), 1);
  db.prepare("INSERT INTO snapshots (id, collected_at, json) VALUES (?, ?, ?)").run("snap-1", "2026-11-15T00:00:00Z", "{\"schemaVersion\":1}");
  db.prepare("INSERT INTO baselines (id, snapshot_id, set_at) VALUES (?, ?, ?)").run("base-1", "snap-1", "2026-11-15T00:00:00Z");

  assert.deepEqual(migrate(db, migrations), []);
  assert.equal(readUserVersion(db), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM snapshots").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM baselines").get()?.count, 1);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
});
