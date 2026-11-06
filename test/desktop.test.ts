import assert from "node:assert/strict";
import { test } from "node:test";
import { systemDesktop, type Exec } from "../src/desktop.ts";

function fake(results: Record<string, { code: number; stdout: string; timedOut?: boolean } | null>) {
  const calls: { file: string; args: string[]; options?: { timeoutMs?: number } }[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push(options === undefined ? { file, args } : { file, args, options });
    return file in results ? results[file]! : null;
  };
  return { calls, exec };
}

test("notify without a button sends exactly the expected arguments", async () => {
  const f = fake({ "notify-send": { code: 0, stdout: "" } });
  assert.equal(await systemDesktop(f.exec).notify("Synced: 3 changes"), "closed");
  assert.deepEqual(f.calls, [{ file: "notify-send", args: ["--app-name=nopipeline", "--icon=folder-sync", "nopipeline", "Synced: 3 changes"] }]);
});

test("notify with a button waits and reports the click", async () => {
  const f = fake({ "notify-send": { code: 0, stdout: "open\n" } });
  assert.equal(await systemDesktop(f.exec).notify("x", "Open report"), "clicked");
  assert.deepEqual(f.calls[0]!.args, ["--app-name=nopipeline", "--icon=folder-sync", "--expire-time=0", "--action=open=Open report", "nopipeline", "x"]);
  const g = fake({ "notify-send": { code: 0, stdout: "" } });
  assert.equal(await systemDesktop(g.exec).notify("x", "Open report"), "closed");
});

test("notify reports a missing notify-send", async () => {
  assert.equal(await systemDesktop(fake({}).exec).notify("x", "b"), "missing");
});

test("open hands the URL to xdg-open through the injected spawner", async () => {
  const calls: string[][] = [];
  const d = systemDesktop(fake({}).exec, async (file, args) => (calls.push([file, ...args]), file === "xdg-open"));
  assert.equal(await d.open("obsidian://x"), true);
  assert.deepEqual(calls, [["xdg-open", "obsidian://x"]]);
  assert.equal(await systemDesktop(fake({}).exec, async () => false).open("u"), false);
});

test("notify with a wait cap passes it to the program; a capped wait counts as shown", async () => {
  const f = fake({ "notify-send": { code: 1, stdout: "", timedOut: true } });
  assert.equal(await systemDesktop(f.exec).notify("x", "Open report", { waitMs: 600_000 }), "closed");
  assert.deepEqual(f.calls[0]!.options, { timeoutMs: 600_000 });
  const g = fake({ "notify-send": { code: 0, stdout: "" } });
  await systemDesktop(g.exec).notify("x", "Open report");
  assert.equal(g.calls[0]!.options, undefined);
});

test("a non-zero exit of notify-send is failed", async () => {
  const f = fake({ "notify-send": { code: 1, stdout: "" } });
  assert.equal(await systemDesktop(f.exec).notify("x"), "failed");
  assert.equal(await systemDesktop(f.exec).notify("x", "b"), "failed");
});
