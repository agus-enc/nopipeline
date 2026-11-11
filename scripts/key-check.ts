// Opens a GitHub issue when the OBS repo key shipped in the latest release expires within 90 days (or OBS serves another key).
// Run monthly by .github/workflows/key-check.yml. Needs gh (with GH_TOKEN), gpg and curl. A fetch failure exits 1 and opens no issue.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const DAY = 86400;
const WARN_SECONDS = 90 * DAY;
const ASSET = "nopipeline-archive-keyring.gpg";
/** The procedure for renewing the key; Task 8 writes the section with this anchor. */
const DOCS_PATH = "docs/development.md#obs-repo-key";
const CHANGED_TITLE = "OBS repo key changed";

const run = promisify(execFile);

export type Issue = { title: string; body: string };

const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The issue to open, or null. Times are Unix seconds; 0 means the key does not expire. */
export function decide(input: { shippedExpires: number; servedExpires: number; servedMatchesPin: boolean; now: number; docsUrl?: string | undefined }): Issue | null {
  const docs = input.docsUrl ?? DOCS_PATH;
  if (!input.servedMatchesPin) {
    return {
      title: CHANGED_TITLE,
      body: `The key OBS serves for the project no longer has the fingerprint pinned in packaging/obs-signing-key.fingerprint, so releases would refuse to ship it.\n\nCheck with the OBS project owner whether the key was replaced on purpose. If it was, update the pin; if not, treat it as an incident.\n\nProcedure: ${docs}\n`,
    };
  }
  if (input.shippedExpires === 0) return null;
  if (input.shippedExpires - input.now >= WARN_SECONDS) return null;
  const date = isoDate(input.shippedExpires);
  const next =
    input.servedExpires > input.shippedExpires
      ? `OBS already serves the extended key (valid until ${isoDate(input.servedExpires)}): tag a patch release so the packages ship it.`
      : "OBS has not extended it yet; check the project's signing keys.";
  return {
    title: `OBS repo key expires on ${date}`,
    body: `The OBS repo key shipped in the latest release expires on ${date}. After that, package managers refuse updates from the OBS repository.\n\n${next}\n\nProcedure: ${docs}\n`,
  };
}

/** True when no open issue already has this exact title. */
export function shouldCreate(openTitles: string[], title: string): boolean {
  return !openTitles.includes(title);
}

/** The primary key's expiry in Unix seconds (0 for none) from a keyring file; --show-keys does not import anything. */
export async function expiryOfKeyring(file: string): Promise<number> {
  const { stdout } = await run("gpg", ["--batch", "--no-tty", "--show-keys", "--with-colons", file]);
  const pub = stdout.split("\n").find((l) => l.startsWith("pub:"));
  if (pub === undefined) throw new Error(`no key in ${ASSET}`);
  const field = pub.split(":")[6] ?? "";
  if (field === "") return 0;
  if (!/^\d+$/.test(field)) throw new Error(`cannot read the expiry in ${ASSET}`);
  return Number(field);
}

export type Deps = {
  shippedExpires: () => Promise<number>;
  served: () => Promise<{ matchesPin: boolean; expires: number }>;
  openTitles: () => Promise<string[]>;
  createIssue: (issue: Issue) => Promise<void>;
  now: () => number;
  docsUrl?: string | undefined;
};

/** Decides and, if needed, opens the issue. Rejects on any fetch failure, before anything is created. */
export async function check(deps: Deps): Promise<void> {
  const shippedExpires = await deps.shippedExpires();
  const served = await deps.served();
  const issue = decide({ shippedExpires, servedExpires: served.expires, servedMatchesPin: served.matchesPin, now: deps.now(), docsUrl: deps.docsUrl });
  if (issue === null) return;
  if (!shouldCreate(await deps.openTitles(), issue.title)) return;
  await deps.createIssue(issue);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nopipeline-key-check-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function realDeps(root: string): Deps {
  const repo = process.env.GITHUB_REPOSITORY;
  return {
    shippedExpires: () =>
      withTempDir(async (dir) => {
        await run("gh", ["release", "download", "--pattern", ASSET, "--dir", dir]);
        return expiryOfKeyring(join(dir, ASSET));
      }),
    served: async () => {
      const project = (await readFile(join(root, "packaging", "obs", "project"), "utf8")).trim();
      const fingerprint = (await readFile(join(root, "packaging", "obs-signing-key.fingerprint"), "utf8")).trim();
      return withTempDir(async (dir) => {
        try {
          await run("sh", [join(root, "packaging", "obs-key.sh"), "--project", project, fingerprint, dir]);
        } catch (error) {
          // obs-key.sh exits 2 when the served key is not the pinned one; any other failure is a failed fetch.
          if ((error as { code?: unknown }).code === 2) return { matchesPin: false, expires: 0 };
          throw error;
        }
        return { matchesPin: true, expires: Number((await readFile(join(dir, "expires"), "utf8")).trim()) };
      });
    },
    openTitles: async () => {
      const { stdout } = await run("gh", ["issue", "list", "--state", "open", "--search", "OBS repo key in:title", "--json", "title", "--limit", "100"]);
      return (JSON.parse(stdout) as { title: string }[]).map((i) => i.title);
    },
    createIssue: async (issue) => {
      await run("gh", ["issue", "create", "--title", issue.title, "--body", issue.body]);
    },
    now: () => Date.now() / 1000,
    docsUrl: repo ? `https://github.com/${repo}/blob/main/${DOCS_PATH}` : undefined,
  };
}

async function main(): Promise<void> {
  try {
    await check(realDeps(process.cwd()));
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n")[0] ?? (error instanceof Error ? error.message.split("\n")[0] : String(error));
    console.error(`key-check: ${detail}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
