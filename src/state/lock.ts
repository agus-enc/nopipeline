// One sync at a time: a lock file holding the running process id.
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Another live sync holds the lock. */
export class LockTakenError extends Error {}

/** Takes the lock, or throws if another live sync holds it. Returns a function that releases it. */
export async function acquireLock(stateDir: string, warn: (message: string) => void): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, "lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        // Only our own lock: if it was deleted by hand and another run took it, that run keeps it.
        if ((await readFile(file, "utf8").catch(() => "")).trim() === String(process.pid)) await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
      if (Number.isInteger(pid) && alive(pid)) {
        throw new LockTakenError(`another sync is running (process ${pid}); if it isn't, delete ${file}`);
      }
      warn(`taking over a stale lock left by process ${Number.isInteger(pid) ? pid : "unknown"}`);
      await rm(file, { force: true });
    }
  }
  throw new Error(`could not take the lock at ${file}`);
}
