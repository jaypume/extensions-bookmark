Changelog
=========

All notable changes to Extensions Bookmark will be documented in this file.

CURRENT VERSION - 1.2.1
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
