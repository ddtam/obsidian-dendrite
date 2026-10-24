# Privacy

Dendrite is an Obsidian plugin that runs on your own computer. It has no server of its own, collects no analytics, and sends nothing to its author.

## Google Docs

When you sign in with Google in Dendrite's settings, Dendrite asks Google only for access to files it creates or that you open with it (the `drive.file` permission). It cannot see any other file in your Google Drive.

With that access Dendrite reads the comments and suggested changes on the doc you link to a manuscript, chosen in Google's own file picker, so you can bring them into your cards, and writes the changes you send to it. It does this only when you ask, from your computer, directly with Google.

Your sign-in token is stored on your computer, outside your vault, and is never sent anywhere except to Google. The OAuth client and Picker API key you paste into Dendrite's settings are kept in those settings, inside your vault, and are used only to sign you in and open Google's picker. You can remove Dendrite's access at any time at https://myaccount.google.com/permissions, or by signing out in Dendrite's settings.

## Other connections

- **Zotero.** Dendrite asks Better BibTeX, running on your computer, for citations when you export.
- **Reviews from programs.** When turned on, Dendrite listens on your computer only (127.0.0.1) for review comments from programs you run, and only with its key. A program with the key can also read a manuscript's open review comments and the replies to them, so a reviewing agent can see what was answered; it can read nothing else from the vault.
- **Timings.** When **Record timings** is turned on, Dendrite writes how long its own steps took, and how often the window stalled, to `~/.config/dendrite/timings.jsonl` on your computer: step names, counts and times only, never text from the vault.

Nothing in these leaves your computer.
