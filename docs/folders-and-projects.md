# Folders and projects

How the vault's folders and a Notion projects database follow each other. [Back to README](../README.md)

This applies when the profile has a projects database (`projectsRelation`, see [Configuration](configuration.md#keys)). A note's **project** is the first entry of its project relation in Notion, and the vault's folders follow it.

## Rules

- A note in a **leaf folder** (a visible folder with no visible subfolders) belongs to the project named like the folder, compared ignoring case.
  - If there is no such project, the sync creates one in the projects database, from that database's default template if it has one, otherwise blank.
  - A folder only becomes a project when it holds at least one note.
- A note at the vault root, or in the default folder (`0-In`), has no project and stays there.
- A note in a folder that has subfolders is moved to the default folder and has no project, unless that folder is already a project.
  - A folder that is already a project keeps its notes when it gets subfolders. The run warns once that it now has subfolders, and the subfolders become projects of their own.
  - The attachment folder never becomes a project.
- In Notion, a page with a project lives in that project's folder.
  - For a project born in Notion that is a new folder at the vault root named after it. It is `Name (2)` if that name is taken by the default folder, the attachment folder, a folder with subfolders or another project's folder.
  - A page without a project goes to the default folder, unless its note sits at the vault root.
- Moving a note to another folder changes the page's first project. Its other projects stay as they are, and the vault ignores them.
- Renaming a folder renames its project, and renaming a project renames its folder.
- A project trashed in Notion leaves its notes without a project, in the default folder.
- If two folders could claim one project, or one folder matches several projects, the sync warns, writes nothing and leaves those notes alone.

## What the sync never does

The sync never edits a project page's content, never filters on an "Archived" property (archived projects are projects), and never creates or changes database properties.
