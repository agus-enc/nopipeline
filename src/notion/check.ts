// What the notes database must look like for a profile: the sync checks it before every run, and the setup before it saves a profile.
import type { Config } from "../config.ts";

/** A database's properties by name: their type and, for a relation, the data source it points to (dashed id). */
export interface DatabaseSource {
  properties: Record<string, { type: string; target?: string }>;
}

export interface DatabaseCheck {
  /** What stops a run (or a profile): each says what to fix. */
  errors: string[];
  /** What is worth saying but changes nothing. */
  notes: string[];
  /** Whether the database has a "Links to" relation to itself, which the sync then keeps. */
  linksTo: boolean;
  /** Whether the database has the multi-select tags property, which the sync then keeps. */
  tags: boolean;
}

export function checkDatabase(
  source: DatabaseSource,
  config: Pick<Config, "titleProperty" | "linksToProperty" | "projectsRelation" | "dataSourceId"> & Partial<Pick<Config, "tagsProperty">>,
): DatabaseCheck {
  const { properties } = source;
  const errors: string[] = [];
  const notes: string[] = [];

  // A wrong title property would rename every note.
  if (properties[config.titleProperty]?.type !== "title") {
    const title = Object.keys(properties).find((name) => properties[name]!.type === "title");
    errors.push(
      `the database's title property is ${title === undefined ? "missing" : `"${title}"`}, not "${config.titleProperty}": rename it back to "${config.titleProperty}" in Notion, or set "titleProperty": ${JSON.stringify(title ?? "…")} in the profile's config file.`,
    );
  }

  let linksTo = false;
  const links = config.linksToProperty === null ? undefined : properties[config.linksToProperty];
  if (config.linksToProperty === null) {
    notes.push(`"linksToProperty" is null in the profile's config file; the Links to relation is left alone`);
  } else if (links === undefined) {
    notes.push(`the database has no "${config.linksToProperty}" property; the Links to relation is left alone`);
  } else if (links.type !== "relation" || links.target !== config.dataSourceId) {
    const kind = links.type === "relation" ? "a relation to another database" : `a ${links.type}`;
    errors.push(
      `the database's "${config.linksToProperty}" property is not a relation to the database itself: it is ${kind}; change it back to a relation to this database in Notion, or set "linksToProperty" in the profile's config file to the relation that holds each note's links.`,
    );
  } else {
    linksTo = true;
  }

  let tags = false;
  if (config.tagsProperty != null) {
    const found = properties[config.tagsProperty];
    if (found === undefined) {
      notes.push(`the database has no "${config.tagsProperty}" property; tags are left alone`);
    } else if (found.type !== "multi_select") {
      notes.push(`the database's "${config.tagsProperty}" property is a ${found.type}, not a multi-select; tags are left alone`);
    } else {
      tags = true;
    }
  }

  const projects = config.projectsRelation === null ? undefined : properties[config.projectsRelation];
  if (config.projectsRelation !== null) {
    if (projects === undefined) {
      errors.push(`the database has no "${config.projectsRelation}" property: add a relation to your projects database in Notion, or take "projectsRelation" out of the profile's config file to keep folders as they are.`);
    } else if (projects.type !== "relation") {
      errors.push(`the database's "${config.projectsRelation}" property is a ${projects.type}, not a relation to the projects database: change it in Notion, or set "projectsRelation" in the profile's config file to the relation that holds each note's project.`);
    } else if (projects.target === config.dataSourceId) {
      errors.push(`the database's "${config.projectsRelation}" relation points to the notes database itself, not to the projects database: change it in Notion, or set "projectsRelation" in the profile's config file to the relation to the projects.`);
    }
  }
  return { errors, notes, linksTo, tags };
}
