import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installAuto, serviceUnit, systemdArg, timerUnit, uninstallAuto, unitNames, type Systemctl } from "../../src/auto/timer.ts";
import { tempDir } from "../helpers/tmp.ts";

test("systemdArg quotes only when needed and escapes \\, \", % and $", () => {
  assert.equal(systemdArg("/usr/bin/node"), "/usr/bin/node");
  assert.equal(systemdArg("/home/a b/cli.ts"), '"/home/a b/cli.ts"');
  assert.equal(systemdArg("/x/100%.json"), "/x/100%%.json");
  assert.equal(systemdArg("/x/$HOME"), "/x/$$HOME");
  assert.equal(systemdArg('/x/"q"'), '"/x/\\"q\\""');
  assert.equal(systemdArg("/x/a\\b"), '"/x/a\\\\b"');
  assert.equal(systemdArg("/x/it's"), `"/x/it's"`);
  assert.equal(systemdArg("/x/a b%$"), '"/x/a b%%$$"');
});

test("unitNames: default profile and others", () => {
  assert.deepEqual(unitNames("config", true), { service: "nopipeline-auto.service", timer: "nopipeline-auto.timer" });
  assert.deepEqual(unitNames("trial", false), { service: "nopipeline-auto-trial.service", timer: "nopipeline-auto-trial.timer" });
  assert.deepEqual(unitNames("a b/c", false), { service: "nopipeline-auto-a-b-c.service", timer: "nopipeline-auto-a-b-c.timer" });
});

test("serviceUnit and timerUnit content", () => {
  const service = serviceUnit({ node: "/usr/bin/node", cli: "/opt/n p/src/cli.ts", configPath: "/home/u/my 100%/c.json", profile: "config" }).split("\n");
  assert.equal(service[0], "# X-nopipeline");
  assert.ok(service.includes("Type=oneshot"));
  assert.ok(service.includes("TimeoutStartSec=1h"));
  assert.ok(serviceUnit({ node: "n", cli: "c", configPath: "/p", profile: "50% off" }).includes("Description=nopipeline automatic sync (50%% off)"));
  assert.ok(timerUnit({ service: "s", profile: "50% off" }).includes("(50%% off)"));
  assert.ok(service.some((l) => l.startsWith("Description=")));
  assert.ok(service.includes('ExecStart=/usr/bin/node "/opt/n p/src/cli.ts" sync --auto --config "/home/u/my 100%%/c.json"'));
  const timer = timerUnit({ service: "nopipeline-auto.service", profile: "config" }).split("\n");
  assert.equal(timer[0], "# X-nopipeline");
  for (const line of ["OnCalendar=*:0/15", "Persistent=true", "Unit=nopipeline-auto.service", "[Install]", "WantedBy=timers.target"]) assert.ok(timer.includes(line), line);
});

function fake(failOn?: string) {
  const calls: string[][] = [];
  const systemctl: Systemctl = async (args) => {
    calls.push(args);
    return args[0] === failOn ? { code: 1, stderr: "Failed to connect to bus" } : { code: 0, stderr: "" };
  };
  return { calls, systemctl };
}

async function setup(t: Parameters<typeof tempDir>[0]) {
  const dir = await tempDir(t);
  const env = { XDG_CONFIG_HOME: join(dir, "cfg") };
  return { dir, env, units: join(dir, "cfg", "systemd", "user") };
}

test("installAuto writes both units, reloads and enables the timer", async (t) => {
  const { env, units } = await setup(t);
  const { calls, systemctl } = fake();
  const configPath = join(env.XDG_CONFIG_HOME, "nopipeline", "config.json");
  const names = await installAuto({ node: "/usr/bin/node", cli: "/opt/cli.ts", configPath, env, systemctl });
  assert.deepEqual(names, { service: "nopipeline-auto.service", timer: "nopipeline-auto.timer" });
  assert.match(await readFile(join(units, "nopipeline-auto.service"), "utf8"), /ExecStart=\/usr\/bin\/node \/opt\/cli.ts sync --auto --config /);
  assert.match(await readFile(join(units, "nopipeline-auto.timer"), "utf8"), /OnCalendar=\*:0\/15/);
  assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", "nopipeline-auto.timer"]]);
});

test("a failing enable removes the files and throws with stderr", async (t) => {
  const { env, units } = await setup(t);
  const { systemctl } = fake("enable");
  await assert.rejects(installAuto({ node: "/usr/bin/node", cli: "/opt/cli.ts", configPath: join(env.XDG_CONFIG_HOME, "x", "config.json"), env, systemctl }), /Failed to connect to bus/);
  await assert.rejects(readFile(join(units, "nopipeline-auto.service")), { code: "ENOENT" });
  await assert.rejects(readFile(join(units, "nopipeline-auto.timer")), { code: "ENOENT" });
});

test("a failing re-install keeps the previous install's files and reloads best-effort", async (t) => {
  const { env, units } = await setup(t);
  const configPath = join(env.XDG_CONFIG_HOME, "nopipeline", "config.json");
  await installAuto({ node: "/old/node", cli: "/opt/cli.ts", configPath, env, systemctl: fake().systemctl });
  const oldService = await readFile(join(units, "nopipeline-auto.service"), "utf8");
  const oldTimer = await readFile(join(units, "nopipeline-auto.timer"), "utf8");
  const { calls, systemctl } = fake("enable");
  await assert.rejects(installAuto({ node: "/new/node", cli: "/opt/cli.ts", configPath, env, systemctl }), /Failed to connect to bus/);
  assert.equal(await readFile(join(units, "nopipeline-auto.service"), "utf8"), oldService);
  assert.equal(await readFile(join(units, "nopipeline-auto.timer"), "utf8"), oldTimer);
  assert.deepEqual(calls.at(-1), ["daemon-reload"]);
  // A reload that fails during the cleanup does not hide the original error.
  const failing: Systemctl = async (args) => ({ code: 1, stderr: `${args[0]} failed` });
  await assert.rejects(installAuto({ node: "/new/node", cli: "/opt/cli.ts", configPath, env, systemctl: failing }), /daemon-reload failed/);
  assert.equal(await readFile(join(units, "nopipeline-auto.timer"), "utf8"), oldTimer);
});

test("uninstallAuto disables, removes, reloads; then reports absent", async (t) => {
  const { env, units } = await setup(t);
  const configPath = join(env.XDG_CONFIG_HOME, "nopipeline", "trial.json");
  await installAuto({ node: "/usr/bin/node", cli: "/opt/cli.ts", configPath, env, systemctl: fake().systemctl });
  assert.ok(await readFile(join(units, "nopipeline-auto-trial.timer"), "utf8"));
  const { calls, systemctl } = fake();
  assert.equal(await uninstallAuto({ configPath, env, systemctl }), "removed");
  assert.deepEqual(calls, [["disable", "--now", "nopipeline-auto-trial.timer"], ["daemon-reload"]]);
  await assert.rejects(readFile(join(units, "nopipeline-auto-trial.service")), { code: "ENOENT" });
  await assert.rejects(readFile(join(units, "nopipeline-auto-trial.timer")), { code: "ENOENT" });
  const again = fake();
  assert.equal(await uninstallAuto({ configPath, env, systemctl: again.systemctl }), "absent");
  assert.deepEqual(again.calls, []);
});

test("uninstallAuto leaves a file without the marker alone", async (t) => {
  const { env, units } = await setup(t);
  await mkdir(units, { recursive: true });
  await writeFile(join(units, "nopipeline-auto.timer"), "[Timer]\nOnCalendar=daily\n");
  const { calls, systemctl } = fake();
  assert.equal(await uninstallAuto({ configPath: join(env.XDG_CONFIG_HOME, "nopipeline", "config.json"), env, systemctl }), "not ours");
  assert.deepEqual(calls, []);
  assert.match(await readFile(join(units, "nopipeline-auto.timer"), "utf8"), /daily/);
});
