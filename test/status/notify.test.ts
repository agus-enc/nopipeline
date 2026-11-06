import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationFor, reportUrl, type Ending } from "../../src/status/notify.ts";

const base: Ending = { kind: "sync", changes: 0, needLook: 0, heldNotes: 0, heldFiles: 0, listChanged: false, statusWritten: true };
const n = (over: Partial<Ending>) => notificationFor({ ...base, ...over });

test("clean runs", () => {
  assert.deepEqual(n({}), { text: "Everything was already in sync", openReport: false });
  assert.deepEqual(n({ changes: 3 }), { text: "Synced: 3 changes", openReport: false });
});

test("things that need a look get the button", () => {
  const r = n({ changes: 5, needLook: 2 });
  assert.match(r.text, /2 notes need a look/);
  assert.match(n({ changes: 1, needLook: 1 }).text, /1 note needs a look/);
  assert.equal(r.openReport, true);
});

test("held trashes beat needs a look", () => {
  const r = n({ heldNotes: 22, needLook: 2 });
  assert.equal(r.text, "Stopped: 22 notes would be trashed (and 2 notes need a look). Confirm from the menu.");
  assert.equal(r.openReport, true);
});

test("first run, preview, busy, failed", () => {
  assert.match(n({ kind: "first-run", changes: 9 }).text, /First run: preview only/);
  assert.deepEqual(n({ kind: "preview", changes: 5 }), { text: "Preview: 5 changes", openReport: true });
  assert.deepEqual(n({ kind: "busy" }), { text: "A sync is already running", openReport: false });
  assert.deepEqual(n({ kind: "failed", error: "boom", statusWritten: false }), { text: "Sync failed: boom", openReport: false });
  assert.equal(n({ kind: "failed", error: "boom" }).openReport, true);
});

test("changed list and taken status note", () => {
  assert.equal(n({ heldNotes: 3, listChanged: true }).text, "The list of trashes changed; check the status note and confirm again.");
  const r = n({ changes: 1, statusTaken: "nopipeline status.md", statusWritten: false });
  assert.equal(r.text, "Synced: 1 change. Status note not written: nopipeline status.md is one of your notes; set statusNote in the profile.");
  assert.equal(r.openReport, false);
  const held = n({ heldNotes: 3, statusTaken: "x.md", statusWritten: false }).text;
  assert.ok(held.includes("Confirm from the menu. Status note not written"), held);
});

test("reportUrl opens the note by its absolute path", () => {
  assert.equal(reportUrl("/home/u/My Vault/Meta/nopipeline status.md"), "obsidian://open?path=%2Fhome%2Fu%2FMy%20Vault%2FMeta%2Fnopipeline%20status.md");
});
