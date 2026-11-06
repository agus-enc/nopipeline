# Development

Checks, probes and live tests for working on nopipeline. [Back to README](../README.md)

```bash
npm run check                                  # type check and all tests
node scripts/check-vault.ts ~/Documents/<your vault>   # read-only: translate every note both ways and simulate edits in both apps, in memory
node scripts/check-vault.ts ~/Documents/<your vault> --digest   # also a digest of each note's Notion translation, to compare versions
node scripts/check-vault.ts ~/Documents/<your vault> --show "Folder/Note.md"   # one note's lines and its Notion translation
NOTION_TOKEN=... node scripts/probe.ts <scratch data source id>   # record real API output as fixtures
NOPIPELINE_LIVE=1 NOTION_TOKEN=... NOPIPELINE_SCRATCH_DATA_SOURCE=<id> npm test   # include the live API test
```

Point the probe and the live test only at a scratch database, never at the real one.

The live tests need the scratch notes database to have a `Project` relation to a scratch projects database (the connection must be connected to both), so the folder and project tests can run.
