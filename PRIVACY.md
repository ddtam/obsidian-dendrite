# Privacy

Dendrite is an Obsidian plugin that runs on your own computer. It has no server of its own, collects no analytics, and sends nothing to its author.

## Google Docs

When you sign in with Google in Dendrite's settings, Dendrite asks Google only for access to files it creates or that you open with it (the `drive.file` permission). It cannot see any other file in your Google Drive.

With that access Dendrite creates a Google Doc from a manuscript when you ask, reads the comments and suggested changes on it so you can bring them into your cards, and writes the changes you send to it. It does this only when you ask, from your computer, directly with Google.

Your sign-in token is stored on your computer, outside your vault, and is never sent anywhere except to Google. You can remove Dendrite's access at any time at https://myaccount.google.com/permissions, or by signing out in Dendrite's settings.

## Other connections

- **Zotero.** Dendrite asks Better BibTeX, running on your computer, for citations when you export.
- **Reviews from programs.** When turned on, Dendrite listens on your computer only (127.0.0.1) for review comments from programs you run, and only with its key.

Nothing in these leaves your computer.
