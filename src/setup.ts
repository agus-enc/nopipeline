// `nopipeline setup`: walks a new user through a profile, reading Notion and the vault and changing nothing in Notion.
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig, PROFILE_NAME } from "./config.ts";
import { checkDatabase } from "./notion/check.ts";
import type { Discovery } from "./notion/discover.ts";
import { normalizeId } from "./notion/ids.ts";
import { usableFolder } from "./vault/filenames.ts";

export interface SetupIo {
  /** Asks a question; an empty answer means the suggestion. */
  ask(question: string, suggestion?: string): Promise<string>;
  /** Asks for a secret without showing what is typed. */
  askSecret(question: string): Promise<string>;
  out(line: string): void;
}

export interface SetupOptions {
  configPath: string;
  env: Record<string, string | undefined>;
  discover: (token: string) => Discovery;
}

type Properties = Record<string, { type: string; target?: string }>;
type Source = { id: string; title: string };

const TRIES = 5;
const yes = (answer: string) => /^y/i.test(answer.trim());
const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);
const exists = (path: string) => stat(path).then((info) => info, () => null);

/** Returns 0 when a profile was written, 1 when the setup stopped (nothing was written). */
export async function runSetup(io: SetupIo, options: SetupOptions): Promise<number> {
  const { out } = io;
  const tokenPath = join(dirname(options.configPath), "token");
  const profileName = basename(options.configPath).replace(/\.json$/, "");
  if (!PROFILE_NAME.test(profileName)) {
    out(`${JSON.stringify(profileName)} can't name a profile: start the file name with a letter or digit, and use only letters, digits, ".", "_", "-" and spaces. Nothing was written.`);
    return 1;
  }

  // 1. The token: the environment's, a saved file, or one pasted now.
  let token: string | null = null;
  let tokenFile: string | null = null;
  let writeTokenFile = false;
  const fromEnv = options.env.NOTION_TOKEN?.trim();
  if (fromEnv && yes(await io.ask("Use the token in NOTION_TOKEN? (no token file is written)", "y"))) token = fromEnv;
  if (token === null) {
    tokenFile = tokenPath;
    if ((await exists(tokenPath))?.isFile() && yes(await io.ask(`Use the existing token file at ${tokenPath}?`, "y"))) {
      token = (await readFile(tokenPath, "utf8")).trim();
    } else {
      if ((await exists(tokenPath)) !== null) out(`note: the existing token file ${tokenPath} will be replaced with this token (other profiles that use it will use the new one).`);
      token = (await io.askSecret("Paste the Notion connection's token (nothing is shown as you type): ")).trim();
      writeTokenFile = true;
    }
  }
  if (!token) {
    out("No token was given. Create a connection at https://www.notion.so/profile/integrations and copy its token.");
    return 1;
  }
  // Whatever the SDK says, the token is never repeated.
  const clean = (message: string) => message.split(token).join("…");
  const discovery = options.discover(token);
  try {
    out(`Connected to Notion as "${clean(await discovery.whoAmI())}".`);
  } catch (error) {
    out(`Notion did not accept the token (${clean(error instanceof Error ? error.message : String(error))}). Check that you copied the connection's whole token. Nothing was written.`);
    return 1;
  }

  // 2. The databases the connection can see.
  let sources: Source[];
  try {
    sources = await discovery.dataSources();
  } catch (error) {
    out(`Could not list the databases the connection can see (${clean(error instanceof Error ? error.message : String(error))}). Nothing was written.`);
    return 1;
  }
  if (sources.length === 0) {
    out("The connection can't see any database. In Notion, open your notes database (and the projects one), use the ••• menu, Connections, and add this connection to each. Then run setup again.");
    return 1;
  }
  const listed = (id: string) => sources.some((source) => source.id === id);
  const pick = async (question: string, allowNone: boolean, not?: string): Promise<Source | null | undefined> => {
    sources.forEach((source, index) => out(`  ${index + 1}. ${source.title} (id ends ${source.id.slice(-4)})`));
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const answer = (await io.ask(question)).trim();
      if (allowNone && /^none$/i.test(answer)) return null;
      const number = /^\d+$/.test(answer) ? sources[Number(answer) - 1] : undefined;
      const id = number?.id ?? normalizeId(answer);
      if (id === undefined || id === null) {
        out(`Answer with a number from the list${allowNone ? ', or "none"' : ""}.`);
        continue;
      }
      if (id === not) {
        out("The projects database has to be different from the notes database.");
        continue;
      }
      const known = sources.find((source) => source.id === id);
      if (known) return known;
      try {
        // Pasted ids the search didn't list: the warning comes later, once the title is known.
        return { id, title: (await discovery.schema(id)).title };
      } catch {
        out("The connection can't read a database with that id.");
      }
    }
    return undefined;
  };
  const notes = await pick("Which of these is your notes database? (number)", false);
  if (!notes) return 1;
  const projects = await pick('Which is your projects database? (number, or "none" to keep folders as they are)', true, notes.id);
  if (projects === undefined) return 1;
  if (projects === null) out("If your projects database isn't listed, connect the connection to it in Notion (••• → Connections) and run setup again.");

  // 3. The title property and the relation to the projects.
  let notesSchema: { title: string; properties: Properties };
  try {
    notesSchema = await discovery.schema(notes.id);
  } catch (error) {
    out(`The connection can't read "${notes.title}" (${clean(error instanceof Error ? error.message : String(error))}). Add the connection to it in Notion (the ••• menu, Connections). Nothing was written.`);
    return 1;
  }
  const titleProperty = Object.keys(notesSchema.properties).find((name) => notesSchema.properties[name]!.type === "title");
  if (titleProperty === undefined) {
    out(`"${notes.title}" has no title property. Nothing was written.`);
    return 1;
  }
  const choose = async (question: string, names: string[], noneLabel?: string): Promise<string | null | undefined> => {
    names.forEach((name, index) => out(`  ${index + 1}. ${name}`));
    if (noneLabel !== undefined) out(`  none. ${noneLabel}`);
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const answer = (await io.ask(question)).trim();
      if (noneLabel !== undefined && /^none$/i.test(answer)) return null;
      const chosen = names[Number(answer) - 1];
      if (chosen !== undefined) return chosen;
      out(`Answer with a number from the list${noneLabel !== undefined ? ', or "none"' : ""}.`);
    }
    return undefined;
  };

  let projectsRelation: string | undefined;
  if (projects) {
    let projectsSchema: { title: string; properties: Properties };
    try {
      projectsSchema = await discovery.schema(projects.id);
    } catch (error) {
      out(`The connection can't read "${projects.title}" (${clean(error instanceof Error ? error.message : String(error))}). Add the connection to it in Notion (the ••• menu, Connections). Nothing was written.`);
      return 1;
    }
    if (!Object.values(projectsSchema.properties).some((property) => property.type === "title")) {
      out(`"${projects.title}" has no title property, so projects can't be named. Nothing was written.`);
      return 1;
    }
    const relations = Object.keys(notesSchema.properties).filter((name) => {
      const property = notesSchema.properties[name]!;
      return property.type === "relation" && property.target === projects.id;
    });
    if (relations.length === 0) {
      out(`"${notes.title}" has no relation to "${projects.title}": add one in Notion (a Relation property pointing to "${projects.title}"), then run setup again. Nothing was written.`);
      return 1;
    }
    const chosen = relations.length === 1 ? relations[0] : await choose("Which relation holds each note's project? (number)", relations);
    if (chosen === undefined || chosen === null) return 1;
    projectsRelation = chosen;
    out(`Each note's project: "${projectsRelation}".`);
  }

  // 4. The optional Links to relation: a relation from the notes to themselves.
  const selfRelations = Object.keys(notesSchema.properties).filter((name) => {
    const property = notesSchema.properties[name]!;
    return property.type === "relation" && property.target === notes.id;
  });
  let linksToProperty: string | null = null;
  if (selfRelations.length === 0) {
    out(`"${notes.title}" has no relation to itself, so links between notes aren't copied into a Notion property. The sync works without it; to add it, create a Relation property in Notion that points to "${notes.title}" itself, and run setup again.`);
  } else {
    // One relation is confirmed; with several, the pick is the answer (and "none" turns Links to off).
    if (selfRelations.length === 1) {
      if (yes(await io.ask(`Use "${selfRelations[0]!}" as the Links to relation (it lists the notes each note links to)?`, "y"))) linksToProperty = selfRelations[0]!;
    } else {
      const picked = await choose('Which relation should hold the links between notes? (number, or "none" to turn Links to off)', selfRelations, "turn Links to off");
      if (picked === undefined) return 1;
      linksToProperty = picked;
    }
  }

  // The keys the setup never asks about stay as the profile it replaces has them (read now: the tags check below uses its tagsProperty).
  const replaced: Record<string, unknown> = await readFile(options.configPath, "utf8").then(
    (text) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    },
    () => ({}),
  );
  const keptTags = typeof replaced.tagsProperty === "string" || replaced.tagsProperty === null ? replaced.tagsProperty : "Tags";

  // The same check the sync makes before every run.
  const check = checkDatabase(notesSchema, {
    dataSourceId: notes.id,
    titleProperty,
    linksToProperty,
    projectsRelation: projectsRelation ?? null,
    tagsProperty: keptTags,
  });
  if (check.errors.length > 0) {
    out(`The notes database isn't ready: ${check.errors.join(" ")} Nothing was written.`);
    return 1;
  }
  // Without a chosen relation the check only repeats that Links to is off, which was explained above.
  // The tags note is the one about a "Tags" property (the default; setup doesn't write another name).
  for (const note of check.notes) if (linksToProperty !== null || note.endsWith("tags are left alone")) out(`note: ${note}`);

  // 5. The vault and the default folder.
  let vaultPath: string | undefined;
  for (let attempt = 0; attempt < TRIES && vaultPath === undefined; attempt++) {
    const typed = (await io.ask("Path to your Obsidian vault (the folder that holds .obsidian)")).trim();
    const full = expand(typed);
    if (!full.startsWith("/")) out("Give the whole path, like /home/you/Notes or ~/Notes.");
    else if (!(await exists(full))?.isDirectory()) out(`There is no folder at ${typed}.`);
    else if (!(await exists(join(full, ".obsidian")))?.isDirectory()) out(`${typed} has no .obsidian folder, so it isn't an Obsidian vault: open it once in Obsidian, or pick the vault's top folder.`);
    else vaultPath = typed;
  }
  if (vaultPath === undefined) return 1;
  // The name obsidian://open links use for the vault: what Obsidian shows for it, which is the folder's name unless it was renamed there.
  const folderName = basename(expand(vaultPath));
  const typedName = (await io.ask("Vault name as Obsidian shows it (obsidian://open links to your notes use it)", folderName)).trim();
  const vaultName = typedName === "" ? folderName : typedName;
  let inboxFolder: string | undefined;
  for (let attempt = 0; attempt < TRIES && inboxFolder === undefined; attempt++) {
    const typed = (await io.ask("Default folder for notes created in Notion", "0-In")).trim();
    if (usableFolder(typed)) inboxFolder = typed;
    else out('Use a folder name inside the vault, like "0-In" or "Inbox/Notion" (no "..", no names starting with ".", none of \\ : * ? " < > | # ^ [ ]).');
  }
  if (inboxFolder === undefined) return 1;

  // 6. Warnings: things seen without changing anything.
  const appJson = await readFile(join(expand(vaultPath), ".obsidian", "app.json"), "utf8").then(
    (text) => text,
    () => null,
  );
  let markdownLinks = false;
  try {
    markdownLinks = (JSON.parse(appJson ?? "") as { useMarkdownLinks?: unknown }).useMarkdownLinks === true;
  } catch {
    // Unreadable counts as not set.
  }
  if (!markdownLinks) {
    out('warning: Obsidian is set to "Use [[Wikilinks]]" (or its settings could not be read). The sync writes links as Markdown links: turn "Use [[Wikilinks]]" off in Settings → Files and links, so the links you type match.');
  }
  for (const source of [notes, projects]) {
    if (source && !listed(source.id)) out(`warning: "${source.title}" is not in the list of databases the connection can see: add the connection to it in Notion (the ••• menu, Connections) before you sync.`);
  }
  if (projects) {
    let template = false;
    try {
      template = await discovery.hasDefaultTemplate(projects.id);
    } catch {
      // Reported the same way as no template: projects start blank.
    }
    if (!template) out(`warning: "${projects.title}" has no default template, so projects the sync creates start blank. Set a default template in Notion if you want them to look a certain way.`);
  }

  // 7. Write the profile (asking before replacing one), then the token file.
  if ((await exists(options.configPath)) && !yes(await io.ask(`${options.configPath} already exists. Overwrite it?`, "n"))) {
    out("Kept the existing profile. Nothing was written.");
    return 1;
  }
  const kept = ["pageIcon", "massTrashLimit", "tagsProperty"].filter((key) => replaced[key] !== undefined && (key !== "tagsProperty" || keptTags === replaced.tagsProperty));
  // A null linksToProperty really turns the relation off; leaving the key out would bring the "Links to" default back.
  const profile: Record<string, unknown> = { vaultPath, dataSourceId: notes.id, titleProperty };
  if (projectsRelation !== undefined) profile.projectsRelation = projectsRelation;
  if (vaultName !== folderName) profile.vaultName = vaultName;
  profile.linksToProperty = linksToProperty;
  profile.inboxFolder = inboxFolder;
  for (const key of kept) profile[key] = replaced[key];
  if (kept.length > 0) out(`note: kept ${kept.join(" and ")} from the profile it replaced.`);
  if (tokenFile !== null) profile.tokenFile = tokenFile;
  await mkdir(dirname(options.configPath), { recursive: true });
  if (writeTokenFile && tokenFile !== null) {
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    out(`Saved the token to ${tokenFile} (readable by you only).`);
  } else if (tokenFile !== null) {
    await chmod(tokenFile, 0o600);
  }
  await writeFile(options.configPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  try {
    await loadConfig(options.configPath, options.env);
  } catch (error) {
    out(`Wrote ${options.configPath}, but it doesn't load: ${clean(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
  out(`Saved the profile to ${options.configPath}.`);
  out(`Next, preview what a sync would do: npm run sync -- --dry-run --config ${options.configPath}`);
  return 0;
}
