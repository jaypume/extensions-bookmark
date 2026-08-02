Changelog
=========

All notable changes to Extensions Bookmark will be documented in this file.

CURRENT VERSION - 1.8.1
-----------------------
### CHANGES

- **New bookmarks from installed extensions default to Unfavorite.** Adding an extension that is already installed — from the Unbookmarked/Diff bucket, by ID, or from a list — now starts as Unfavorite instead of Favorite. The extension is bookmarked but not treated as "wanted". Adding an extension that is not installed still defaults to Favorite.
- **Category deletion requires confirmation.** Removing a category now asks for explicit confirmation first (its bookmarks are moved to Default on delete), preventing accidental removal.

CURRENT VERSION - 1.8.0
-----------------------
### CHANGES

- **Per-group expand state.** Each category (and Wanted / Installed / Age group) you expand is now remembered individually and restored after a window reload, replacing the single global expand/collapse toggle. Persisted to the local `ui-state.json` (not synced).
- **Wanted / Not Wanted renamed to Favorite / Unfavorite.** All user-facing labels — menus, inline buttons, group headers, tooltips, details — now say Favorite / Unfavorite. Underlying data, fields, and command ids are unchanged, so existing bookmarks and shortcuts keep working.

CURRENT VERSION - 1.7.0
-----------------------
### CHANGES

- **View state is remembered.** Group By, Filter, Sort, and the expand/collapse state are now restored after a window reload. They persist to a standalone local file (`ui-state.json`) that is never written to `data.json` and is not synced.
- **Default sort is Added New → Old.** New installs (or a cleared `ui-state.json`) now sort bookmarks newest-first instead of A → Z.
- **Find defaults to substring match.** The List toolbar search opens VS Code's native filter in "Type to filter" (contiguous) mode instead of fuzzy matching. Your global setting is left untouched.
- **Active filter indicator.** The Filter toolbar button switches to a filled funnel icon whenever a filter other than All is active.

CURRENT VERSION - 1.6.0
-----------------------
### CHANGES

- **Native list filtering.** The List toolbar search button now opens VS Code's native TreeView filter for the current bookmark list.
- **Global search moved to More Actions.** The existing QuickPick search remains available from the Command Palette and now appears at the top of the List view's More Actions menu.

CURRENT VERSION - 1.5.0
-----------------------
### CHANGES

- **Diff bucket in Wanted / Installed grouping.** Both the *Group by Wanted* and *Group by Installed* views now show a **Diff** bucket collecting extensions whose expected state (`wanted`) disagrees with their actual install state — e.g. wanted but missing, unwanted but installed, or installed but unbookmarked. Makes drift visible at a glance.
- **Inline buttons act on the clicked row only.** The star / not-wanted / install / uninstall buttons on each row now ignore multi-selection — clicking one only changes that row, even when several rows are selected.
- **Batch actions in the context menu.** Right-click on one or more bookmarks to **Install**, **Uninstall**, **Mark Wanted**, **Mark Not Wanted**, or **Sync** the whole selection in one go. (The context menu keeps its multi-select behavior; only the inline buttons are single-row.)
- **Local icon cache.** Bookmark icons now load from `globalStorage/icons` and refresh in the background at most once every seven days. Bookmarking an extension or installing/updating it triggers an immediate check, with installed extensions preferring their local package icon. Initial cache population uses four bounded workers, writes metadata once per batch, applies an eight-second request timeout, and summarizes recoverable network failures without Extension Host error stacks. Failed icons retry on the next Extension Host restart.
- **Command Palette shortcuts.** Search, Focus, Add Bookmark, and Add Bookmarks from List are grouped under the `Extensions Bookmark` category; Filter, Group By, and Sort remain available only inside the view.

CURRENT VERSION - 1.3.3
-----------------------
### CHANGES

- **Session state no longer touches disk.** `groupBy`, `sortingOption`, `statusFilter`, and `inputQuery` are kept in memory only — they reset to defaults on window reload. `data.json` now carries just bookmarks, categories, and schemaVersion, so version-control diffs stay clean. On upgrade, any session keys previously written into `data.json` are stripped out automatically.

CURRENT VERSION - 1.3.2
-----------------------
### CHANGES

- **Group by Recently Used.** New Group By option (top of the list) showing the last 20 extensions you touched (install/uninstall/remove/toggle/add), newest first. Tracked in a standalone local file (`recent.json`), never written to `data.json` and not synced.
- **data.json now sorted by id** for a stable, diff-friendly file (UI ordering unchanged).

CURRENT VERSION - 1.3.1
-----------------------
### CHANGES

- **Filter By Input.** Filter dropdown has a new "By Input…" option: type a substring and the list filters by name or id, persisted until you switch filters. Re-clicking the option re-prompts to refine.
- **Filter by No Category.** New filter option showing bookmarks still in the default category.
- **Group by Time Added: "Not Added" bucket.** Bookmarks without an added date (and unbookmarked items) now land in a dedicated bucket at the top instead of "> 1 month".
- **Adding bookmarks no longer prompts for a category** — defaults to "Default"; use Move Bookmark to reclassify later.
- **Inline ⭐/🚫 buttons now auto-sync.** Toggling wanted also installs/uninstalls to match (wanted + missing → install; not wanted + installed → uninstall).
- **Multi-select Add to Bookmarks** for installed-but-unbookmarked items (previously only added one).
- **Expand/collapse state preserved** when switching Sort / Filter (nodes reused by stable id).
- **Empty categories hidden** when grouping by category.

CURRENT VERSION - 1.3.0
-----------------------
### CHANGES

- **Details panel rebuilt as a native TreeView.** Replaces the old Webview with a property-row list (Wanted / Installed / ID / Category / Downloads / Rating / Updated / Added / Note / Open in Marketplace). Click any row to copy its value; click Note to edit via an InputBox. Selecting a bookmark in the List tree drives the Details tree.
- **Dual-emoji status.** Each bookmark now shows `⭐`/`🚫` (wanted) + `✅`/`❌` (installed) next to its name; unbookmarked-installed items show `🆕`. Labels are clean — emojis no longer appended to the name.
- **Removed tags.** The tags system (global tag list, per-bookmark tags, tag commands) is gone. On first launch after upgrade the store migrates to schema v2 and silently drops all tag data; bookmarks, categories, and notes are preserved.
- **Group By submenu.** Category / Wanted / Installed / Time Added / Flat grouping, current marked with ✓.
- **Filter By submenu.** All / Installed / Not Installed / Wanted / Not Wanted / Added in 1 day / 1 week / 1 month. Search honors the active filter.
- **Sort By submenu.** Name A→Z / Z→A, Added New→Old / Old→New, Wanted First / Not Wanted First, Installed First / Missing First. Each option falls back to name then date.
- **Inline action buttons** on each bookmark row: toggle Wanted (⭐/🚫) and install/uninstall (✅/❌). Multi-select supported.
- **Search shows id + status.** The Search quick-pick lists each result with `id · ⭐ ✅` and matches name, id, and status; results respect the active filter.
- **Add Bookmark is its own toolbar button** (one-click). Remaining actions live in the title overflow menu.
- **Expand All / Collapse All** toolbar buttons (toggle by tree state).
- Status emojis moved to the leading icon + inline buttons; the description now shows the extension id.
- Code split into `src/` modules (`store`, `visuals`, `installed`, `marketplace`, `provider`, `detailsView`, `expansion`, `commands`, `logger`).

### Fixes

- Fixed `Install` / `Uninstall` inline buttons being no-ops (they now force the action regardless of `wantedInstall`, and keep data consistent).
- Fixed stale tree nodes after rename/category switch causing reveal to misplace (node caches cleared on refresh).
- Fixed tree expand state context key drifting after manual collapse.
- Reduced duplicate store reads and extension scans when expanding groups.

1.2.1
-----------------------
### CHANGES

- Unbookmarked installed extensions (🆕) now show their own extension icon instead of the fallback codicon.

1.2.0
-----------------------
### CHANGES

- **Detect installed-but-unbookmarked extensions.** On refresh and activation, locally installed extensions that are not in any bookmark are now surfaced in the Diff bucket (grouped by status), under the Default category (grouped by category), and in the flat view. They are marked with a 🆕 emoji and stay visible regardless of the active filter.
- Click a 🆕 item (or right-click → "Add to Bookmarks") to bookmark it. Prefers Marketplace metadata for downloads/rating; falls back to local package data so private or unpublished extensions still bookmark correctly.
- Fixed status and details for newly bookmarked installed extensions (now correctly shown as wanted & installed, ✅).
- "Open in Marketplace" now works on unbookmarked items.

1.1.0
-----------------------
- Renamed to **Extensions Bookmark** (`pujie.extensions-bookmark`); forked from `osxzxso/extension-bookmarker`.
- Storage moved out of `settings.json` into a standalone JSON file under the extension's `globalStorage` directory (`User/globalStorage/pujie.extensions-bookmark/data.json`); legacy `settings.json` data is migrated automatically on first run.

1.0.2
-----------------------
### CHANGES - released on 7/7/2023
- Added more checks to the addBookmark command to address errors when fetching bookmarks with missing data.

1.0.1
-----------------------
### CHANGES - released on 7/6/2023
- Updated README.md file
- Added/Removed exclusions from .gitignore and .vscodeignore files

1.0.0
-----------------------
### CHANGES - released on 7/5/2023
- Initial release of Extension Bookmarker.
- Add and remove bookmarks, as well as select a category to associate each bookmark with.
- Select a bookmark to open it in the VSC Extensions Marketplace.
- Add, rename, and remove categories (folders), as well as move bookmarks from one category to another.
- Search through your bookmarks.
- Import and export all your data.
- Add, rename, and remove tags and assign them to your bookmarks for improved organization, filtering, and retrieval.
- Sort bookmarks in alphabetical (A-Z, Z-A) or chronological (New-Old, Old-New) order.
- Add, edit, and remove a personal note for each bookmark, providing added context and better recall.
- View that includes each bookmark's properties and note, as well as marketplace details such as: download count, rating, and last update date.
- Ability to remove all data in one command (confirmation required).
- Enable Settings Sync to sync data across different installations of VSC.
