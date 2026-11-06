// Watching what reaches the disk: every FileHandle sync, with the path it flushed where the system says it.
import { readlinkSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

/** The paths flushed by FileHandle syncs during the rest of the test (file descriptors where /proc is missing). */
export async function flushes(t: TestContext): Promise<string[]> {
  const probe = await open(fileURLToPath(import.meta.url), "r");
  const handles = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const flushed: string[] = [];
  const sync = handles.sync;
  t.mock.method(handles, "sync", async function (this: FileHandle) {
    let path = `fd ${this.fd}`;
    try {
      path = readlinkSync(`/proc/self/fd/${this.fd}`);
    } catch {
      // no /proc: the descriptor has to do
    }
    flushed.push(path);
    return sync.call(this);
  });
  return flushed;
}
