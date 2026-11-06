// Per-note sync records as plain JSON files, one per Notion page.
import { readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { flush, makeFolders, writeFlushed } from "../durable.ts";
import type { PageId, SyncRecord } from "../types.ts";

export interface RecordStore {
  all(): Map<PageId, SyncRecord>;
  put(record: SyncRecord): Promise<void>;
  remove(id: PageId): Promise<void>;
}

const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A record's file; only a dashed lowercase page id is accepted, so no file can land outside the folder. */
function fileFor(dir: string, id: PageId): string {
  if (!PAGE_ID.test(id)) throw new Error(`not a Notion page id: ${JSON.stringify(id)}`);
  return join(dir, `${id}.json`);
}

export async function openRecordStore(stateDir: string): Promise<RecordStore> {
  const dir = join(stateDir, "records");
  await makeFolders(dir);
  const records = new Map<PageId, SyncRecord>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let record: SyncRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as SyncRecord;
    } catch (error) {
      throw new Error(`can't read the sync record ${file} (${error instanceof Error ? error.message : String(error)}); fix or delete it, then run again`);
    }
    records.set(record.notionId, record);
  }
  return {
    all: () => new Map(records),
    async put(record) {
      const file = fileFor(dir, record.notionId);
      // Flushed before it takes its name, and the name after: a power cut leaves the old record or the new one.
      await writeFlushed(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
      await flush(dir);
      records.set(record.notionId, record);
    },
    async remove(id) {
      await rm(fileFor(dir, id), { force: true });
      records.delete(id);
    },
  };
}
