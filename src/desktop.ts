import { execFile, spawn } from "node:child_process";

export interface Desktop {
  /**
   * Shows a notification; with a button, waits for it (at most `waitMs` when given; a capped wait counts as shown, "closed").
   * "failed": notify-send exited non-zero (no notification server, D-Bus error). Never throws.
   */
  notify(text: string, button?: string, options?: { waitMs?: number }): Promise<"clicked" | "closed" | "missing" | "failed">;
  /** Opens a URL with xdg-open, not waiting for it. Missing → false. */
  open(url: string): Promise<boolean>;
}

/** Runs a program with an argument array (never a shell). null: the program doesn't exist. `timeoutMs` kills it; then `timedOut` is true. */
export type Exec = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; timedOut?: boolean } | null>;

/** Starts a program detached and returns false when it doesn't exist. */
export type Spawner = (file: string, args: string[]) => Promise<boolean>;

export const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}) }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (e.code === "ENOENT") return resolve(null);
      if (options?.timeoutMs !== undefined && e.killed === true) return resolve({ code: 1, stdout: stdout ?? "", timedOut: true });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "" });
    });
  });

const defaultSpawner: Spawner = (file, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

export function systemDesktop(exec: Exec = defaultExec, spawner: Spawner = defaultSpawner): Desktop {
  return {
    async notify(text, button, options) {
      const args = ["--app-name=nopipeline", "--icon=folder-sync"];
      if (button !== undefined) args.push("--expire-time=0", `--action=open=${button}`);
      args.push("nopipeline", text);
      const r = await exec("notify-send", args, button !== undefined && options?.waitMs !== undefined ? { timeoutMs: options.waitMs } : undefined);
      if (r === null) return "missing";
      if (r.timedOut) return "closed";
      if (r.code !== 0) return "failed";
      return button !== undefined && r.stdout.trim() === "open" ? "clicked" : "closed";
    },
    open: (url) => spawner("xdg-open", [url]),
  };
}
