# Dendrite

Column-and-card writing in Obsidian, in the style of [Gingko Writer](https://gingkowriter.com/), for manuscripts, grants and long documents. The argument sits in the left columns and the prose in the right, and export assembles the manuscript from the cards.

Dendrite keeps everything in plain notes:

- **Each card is an ordinary note**, named by an ID such as `GRANT-2026-k3f9q`.
- **A manuscript's index note holds the tree** as a nested list of links:

  ```markdown
  - [[GRANT-2026-7kq2m|Specific Aims]]
      - [[GRANT-2026-c4x9p|Aim 1]]
          - [[GRANT-2026-f81rw|Aim 1 rationale]]
  ```

Without the plugin, the index still reads as a clickable outline and every card as a note. Dendrite stores nothing about a document anywhere else.

## Install

Through [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `ddtam/obsidian-dendrite` as a beta plugin.

## Use

Run **Dendrite: New manuscript**, give it a title and a prefix, and it creates:

```text
<writing folder>/<title>/
    <title>.md     the index note, with dendrite_prefix in its properties
    cards/         one note per card
```

Opening an index note shows it in Dendrite; **Index** in the view's bar opens its markdown instead. A card or index note open as markdown has a Dendrite button in its tab header, which opens the manuscript at that card.

## Writing a card

A **section card** starts with a heading line, `# Research Outline`. The `#` marks the line as a heading; its level comes from the card's depth, so you never choose it. Write numbers into headings yourself, or turn on **Number sections by position** in the manuscript's settings and leave them out: sections are then numbered from where they sit, `1.`, `1.2`, in the view and in export, and renumber when moved. The numbers are never written into your notes.

Cards are edited in Obsidian's own editor, so live preview, `[[` link suggestions, citation suggestions from other plugins, and Obsidian's editor commands and hotkeys all work inside a card. Escape leaves the card, after closing any open suggestion list first.

Obsidian has no public API for putting its editor inside another view, so Dendrite reaches it the way several plugins do, through the editor of an embedded note. If that fails, as an Obsidian update could make it, or if **Use Obsidian's editor in cards** is off, cards use a plain text box instead, which saves the same way. In the text box:

| Key | Action |
| --- | --- |
| Ctrl+B / Ctrl+I | Bold / italic the selection |
| Tab / Shift+Tab | Indent / outdent the line, or every selected line |
| Enter in a list | Continue the list; on an empty item, end it |

| Key | Action |
| --- | --- |
| Arrow keys | Move between cards: up and down within a column, left to the parent, right to a child |
| Enter, or double-click | Edit the card |
| Escape | Save and leave the editor |
| Ctrl+↓ / Ctrl+↑ (or Ctrl+J / Ctrl+K) | New card below / above, in normal mode |
| Ctrl+→ (or Ctrl+L) | New child card, in normal mode |
| Alt+↑ / Alt+↓ | Move the card among its siblings |
| Alt+→ / Alt+← | Indent under the card above / outdent |
| Ctrl+Backspace | Delete the card and its children |
| Ctrl+Z | Undo the last change, to the tree or to a card's text; in a card before you type, undo making it if it is new and empty, or bring back its text from before your last visit |
| Ctrl+Shift+Z or Ctrl+Y | Redo what was undone, in normal mode |
| Ctrl+F | Find in the cards, in either mode |
| 0 to 4 | What the card prints: 0 automatic, 1 heading only, 2 full text, 3 scaffolding, 4 left out; in normal mode |
| Shift+1 to 3 | The card's status: 1 draft, 2 done, 3 revise; in normal mode, on a card whose text prints, by the physical key on any layout |

### Vim-style keys

In normal mode, shown as **NORMAL** in the bar, no card is being edited and letters are commands. **INSERT** means a card is open for writing. In insert mode every key belongs to the text, Ctrl+arrows for moving by word included, and Escape is the only way back to normal mode. They can be turned off in the settings.

| Key | Action |
| --- | --- |
| h j k l | Left to the parent, down, up, right to a child |
| i / a | Edit with the cursor at the start / at the end |
| o / O | New card below / above |
| n | New child card |
| J / K | Move the card down / up |
| > / < | Indent / outdent the card |
| dd | Delete the card and its children |
| u | Undo |
| gg / G | First / last card in the column |
| / | Find in the cards |

**Find** (Ctrl+F, or `/`) searches the cards' notes, so cards far from view count too. Separate words must all appear in a card, in any order, and `"quoted text"` must appear exactly; the bar's toggles add match case, a regular expression in place of words, and narrowing to the selected card's branch. Cards without a match fade, each card shows how many matches its branch holds, and the current match is highlighted in its card. Enter and Shift+Enter step through matches in reading order, Ctrl+Enter edits the card with the match selected, and Escape closes the bar.

**Drag a card** with the mouse or a pen to move it with its branch: any card from anywhere on it, and the selected card by the icon in its top right corner, which turns into a grip under the pointer, so its text can still be selected. Over the top half of another card it goes above it, over the bottom half below it, and over the card's right edge it becomes that card's last child. An accent line shows where it will land, columns scroll near their ends, Escape cancels, and Ctrl+Z undoes a drop. A card cannot be dropped into its own branch.

On a phone, the active card's toolbar offers the same actions, and a long press opens the card's menu, which has the move and indent items.

**Text is never discarded.** A card saves while you type and again whenever you leave it, Escape included. Deleted cards go to Obsidian's trash, and Ctrl+Z restores them.

**Undo covers both the tree and the cards' text.** Inside a card, Ctrl+Z is the editor's own undo, letter by letter, but that history ends when you leave the card. So each visit that changes a card's text becomes one step in the board's undo, beside moves, inserts and deletes, in the order they were made. Opening a card again and pressing Ctrl+Z before typing brings back its text from before the last visit. Redo, Ctrl+Shift+Z or Ctrl+Y, takes back any undo until you make a new change. A step is only undone or redone while the card still holds the text it left there; a card changed since, by sync or in another tab, is left alone and Dendrite says so.

## Splitting and merging cards

While editing a card, **Move selection to a new card below** or **to a new child card** takes the selected text out of the card into a new one; with nothing selected, everything after the cursor moves. Both are in the editor's right-click menu and in the command palette, unbound, for a hotkey of your choosing. The new card is written before the text leaves the original, so a failure leaves the text twice, never nowhere. You stay in the original card, ready to move the next piece.

A card's menu offers **Merge into the card above** and **Merge into the parent card**, which join its text after the other card's and bring its children along.

Undo reverses a move or a merge in one step, but never discards text written since: a moved card you have edited is kept, and a card's text is restored only if it still holds what the change left there.

## Manuscript settings and card properties

**Settings** in the bar edits the manuscript's properties on its index note: a total limit, whether characters count spaces, words per page for page estimates, numbering, and the top heading level for export. The **sliders** button on a card edits its label and its limit.

### Quotas

A quota is in words, characters or pages, fractions allowed (`1/4 page`), and is **required** (set by the call) or a **target** (your own allocation). It is counted from what export would write for that card's branch, so planning text and comments never count.

Each card shows its quota at its bottom left as a target and a bar filled to its use. Hover it for the figures; click it to edit the quota in place. A card without a quota shows a faint target when hovered, to set one.

Quotas waterfall down the tree. A card's **allocations** are the quotas of the nearest cards below it that carry one, and its card shows both what its branch uses against its quota and what is allocated against it, free or over. The bar does the same for the manuscript's total quota. Going over a required quota shows red; over a target, amber.

Quotas in different units are compared by converting through **words per page** and **characters per word**, both manuscript settings. Pages and converted figures are estimates and are marked `~`; an exact page count needs the final layout.

| Property | Where | Holds |
| --- | --- | --- |
| `dendrite_prefix` | index | the card ID prefix |
| `dendrite_limit` | index or card | a quota: `500 words`, `2000 characters`, `0.25 pages` |
| `dendrite_limit_required` | index or card | `true` if the call sets the quota |
| `dendrite_chars_per_word` | index | for comparing character quotas, default 6 |
| `dendrite_count_spaces` | index | `false` to count characters without spaces |
| `dendrite_words_per_page` | index | for page estimates, default 500 |
| `dendrite_number_sections` | index | `true` to number sections by position |
| `dendrite_heading_top` | index | the heading level of a top-level section |

## Other plugins

Cards are ordinary notes, so any plugin that rewrites notes acts on them too. The [Linter](https://github.com/platers/obsidian-linter) plugin's "File name heading" rule would insert a card's ID as its heading, so Dendrite adds the writing folder to Linter's **Folders to ignore**, once and with a notice. It removes only an entry it added itself, and the setting **Keep Linter out of the writing folder** turns this off.

Linter's clean-up still reaches cards, through Dendrite: when you leave a card you changed, Dendrite runs Linter on it with "File name heading" and "Capitalize headings" switched off for that run, so blank lines, emphasis markers and list markers are tidied as on save. **Clean up cards with Linter** turns this off. It uses Linter's internal `runLinterFile`; if a Linter update removes it, cards are simply left unlinted.

## Note types

Dendrite adds a value to each note's `type` property, keeping any values already there, so file lists and colour rules can tell a manuscript from its cards: `"[[dendrite index]]"` on index notes, a link so manuscripts gather on a type page, and `dendrite card` on cards, plain text so hundreds of cards stay out of the vault's links. Both are settings; empty adds none. Opening a manuscript adds them where missing.

## Labels

The index shows each card by a label: the card's heading line if it starts with one, else the first of its `aliases`, else its first words. Dendrite keeps the index's labels in step with the cards, so edit a label in the card, not in the index.

Each card also shows the end of its file name, such as `lchl3` for `DRAC-RAC-2026-lchl3`, faintly at its bottom right. It never changes, so it is a stable way to refer to a card in notes or conversation: a click copies it, and typing it into find selects that card and marks the id.

## What prints: card roles

Each card has a role, which decides what of it prints:

| Role | Prints | Default for |
| --- | --- | --- |
| Heading only | its heading line; the rest of its text is notes | a card with children |
| Full text | its heading, if any, and its text | a card without children |
| Scaffolding | nothing from the card; its children print in its place, a heading level up and numbered as its siblings | never by default |
| Left out | nothing from the card or its branch | never by default |

Every card shows its role as an icon in its top right corner, faint when the role follows from the tree and stronger when set on the card; clicking the icon offers the roles, each with its number key, and in normal mode the keys 0 to 4 set the selected card's role directly. Set a card's role there or from its right-click menu; it is stored as `dendrite_role` (`section`, `prose`, `scaffolding` or `notes`) on the card. An outline card in the first column, holding a heading and your notes, is set to **Heading only** so its notes stay out even before it has children. A scaffolding card, such as a question the sections beneath it answer, shows with a dotted outline and muted text; a left-out card shows with a dashed outline; a heading-only card shows its notes muted. `%% comments %%` never print.

## Card status

A card's status describes its text, and every card that prints holds one, as `dendrite_status`, so each card says what it is without Dendrite; cards that do not print hold none. Opening a manuscript gives `draft` to any printing card without a status.

| Status | Meaning |
| --- | --- |
| draft | written, not yet worked over (the default) |
| done | "I like where this is; leave it" |
| revise | needs another pass, from your own read or a reviewer's comment |
| unsplit | set by Dendrite on a card whose text you started moving into children and left some behind |

A card's status shows at its top right, beside the role icon, in a band at the top of every card that all its text starts below, as the footer is a row for the quota and the tools. Only revise and unsplit are coloured, as flags: a chip on the card and a faint bar in the preview. Done shows a quiet tick; draft shows nothing. A section, which prints only its heading, shows how many cards below it are flagged. The bar tallies the statuses, so near submission the draft count is what is left.

**+** marks the active card done and **−** sends it to revise; **]** and **[** go to the next and previous flagged card, and a command goes to the next draft. Moved text keeps its card's status and any role set on it, except heading only, and a merge keeps the less mature of the two. A card that stops printing, because it gained children, loses its status; unsplit clears itself once only the heading and comments are left, or with **Keep the leftover text as notes**.

Colours come from the [Pretty Properties](https://github.com/anareaty/pretty-properties) plugin, if it gives `dendrite_status` values a colour, so the Properties panel and the board agree.

To set a role or status on a card and everything below it, use **Whole branch** in its menu, or Alt with the same keys: Alt+0 to Alt+4 for a role, Alt+Shift+1 to 3 for a status, which only cards that print their text take. The whole change is one undo.

## Preview

**Preview** in the bar opens the manuscript as export would print it, beside the board, updating as cards save. Each card's part is its own block: click one to select that card on the board, double-click to edit it, and the board's active card is highlighted in the preview. **Show left out** also shows, dimmed, the text that does not print, so you can check what your roles leave out. Editing stays in the cards, since the printed text is transformed (headings levelled and numbered, notes and comments dropped).

## Export

**Export** in the bar, or a card's menu for one branch, writes to `exports/` beside the index, as markdown, PDF or Word: what the preview shows, with headings levelled by each card's depth and the text tidied like the Linter's blank-line rules.

Footnotes are numbered across the whole manuscript. Each card can number its own from `[^1]`, as the Linter's re-index rule does; on export every reference gets a new number in reading order and the definitions are gathered at the end, so two cards' notes never collide. The preview shows the notes with the same numbers, gathered under each top-level section by default; the menu in its bar moves them to the end of the document, or back under each card. Inline footnotes, `^[text]`, are numbered in the same sequence, and notes with the same text, such as one citation cited in two places, become one note that both references point to; a citation with a different page stays its own note. Anything in code is left as written.

PDF and Word go through [Pandoc](https://pandoc.org) on the desktop, PDF with `xelatex` from TeX Live. Citations are written in cards as `[@citekey]` and fetched at export, exactly the keys used, from Zotero through [Better BibTeX](https://retorque.re/zotero-better-bibtex/); a key the library lacks stops the export and is named. With Zotero closed, a fallback `.bib` set in the settings is used, or the export stops. The citation style is set per manuscript in its Settings, as a CSL file in the vault; with none, Pandoc's default, Chicago author-date, is used. A PDF opens in a pane beside the board, and a Word file in the system's default app. Obsidian's links become their text and embedded images real images.

### How the PDF and Word files look

Set in the manuscript's settings, under **PDF and Word**, or as properties on the index note:

| Property | For | Example | Unset |
| --- | --- | --- | --- |
| `dendrite_font` | PDF | `Arial` | Latin Modern, LaTeX's own |
| `dendrite_font_size` | PDF | `10` (points: 8, 9, 10, 11, 12, 14, 17 or 20) | 10 |
| `dendrite_margin` | PDF | `2cm`, `1in` (a bare number is cm) | 2.5cm |
| `dendrite_paper` | PDF | `a4` or `letter` | letter |
| `dendrite_line_spacing` | PDF | `1.15` | single |
| `dendrite_page_numbers` | PDF | `false` to leave them off | numbered consecutively at the foot |
| `dendrite_pandoc_defaults` | both | `styles/grant.yaml`, a Pandoc defaults file for anything else | none |
| `dendrite_reference_docx` | Word | `styles/reference.docx`, whose styles Word export copies | Pandoc's |

The font must be installed on the computer that exports. Word takes its fonts and sizes only from a reference document: **Make reference.docx** in the settings writes Pandoc's own beside the index, to open in Word, restyle and save. The settings win over a defaults file.

## Export from the command line

`scripts/dendrite-export.mjs` shows what a manuscript exports without Obsidian, for checking a draft from a terminal or another tool. It calls the same functions Export, the preview and the quota bars use, and only reads files.

```
node scripts/dendrite-export.mjs <index.md>            # the markdown Export writes
node scripts/dendrite-export.mjs <index.md> --report   # words, pages and quota per top-level section
node scripts/dendrite-export.mjs <index.md> --map      # each card: role, depth, number, printed and left-out words
```

`--json` gives the report or map as JSON. Cards are found by file name in the index's folder, then anywhere in the vault outside dot-folders. Properties are read as flat `key: value` lines, as Dendrite writes them. A test exports one manuscript both ways and checks the two agree.

## Development

```bash
npm install
npm test          # core and view tests against an in-memory vault
npm run build     # bundles src/ into main.js
```

## Acknowledgements

Inspired by [Gingko Writer](https://gingkowriter.com/) and by [Lineage](https://github.com/ycnmhd/obsidian-lineage) by ycnmhd, which brought the Gingko model to Obsidian.
