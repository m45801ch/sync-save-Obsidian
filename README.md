# Sync Save

> Beautiful, reliable cloud sync for Obsidian

Sync Save bridges your Obsidian vault with any cloud storage — S3-compatible services, WebDAV servers, Dropbox, and OneDrive. Designed with a polished interface that feels native to Obsidian.

## Features

**Multiple Cloud Services**
- S3-Compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO)
- WebDAV (NextCloud, Synology, InfiniCLOUD)
- Dropbox (App Folder mode)
- OneDrive (App Folder mode)

**Sync Capabilities**
- Manual one-click sync from ribbon or command palette
- Scheduled auto sync (configurable interval)
- Sync on save (triggered per file change)
- End-to-end encryption (AES-256-GCM via Web Crypto API)
- Smart conflict detection

**Design Highlights**
- Card-based settings UI with service provider grid
- Real-time sync status in the status bar
- Animated sync indicators (pulsing dot, spinning ribbon)
- Connection testing with visual feedback
- Session sync log with timestamps
- Full dark/light mode support

## Installation

### From Obsidian Community Plugins (pending)

Search for "Sync Save" in the community plugin list.

### Manual Installation

1. Download the latest release from Releases
2. Extract to `{vault}/.obsidian/plugins/sync-save/`
3. Enable the plugin in Obsidian settings

## Usage

1. Open Sync Save settings
2. Select a cloud provider from the grid
3. Enter your credentials and connection details
4. Click "Test" to verify the connection
5. Click "Sync Now" to begin syncing

## Configuration

| Setting | Description |
|---------|-------------|
| Sync on Save | Automatically sync when any file changes |
| Sync Config Files | Include `.obsidian/` configuration |
| Skip Hidden Files | Ignore files starting with `.` or `_` |
| Auto Sync Interval | Periodic sync in minutes (0 = disabled) |
| Skip Paths | Regex patterns for files to exclude |
| Conflict Strategy | How to handle file conflicts |
| Encryption Password | End-to-end encryption passphrase |

## Sync directions, safety, and recovery

Choose a sync direction deliberately:

- **Bidirectional** compares local and cloud changes and applies the selected conflict strategy when both changed.
- **Upload-only** sends local additions and edits to the cloud, without downloading cloud changes.
- **Download-only** pulls cloud additions and edits to the vault, without uploading local changes.
- **Upload-delete** pushes local additions and edits; a remote file that was previously synced and is now deleted locally is moved to the remote `.sync-trash/<date>/` folder.
- **Download-delete** pulls cloud additions and edits; a local file that was previously synced and is now deleted in the cloud is moved to the selected local system or Obsidian trash.

Remote deletions are never permanently deleted during sync: they always move to `.sync-trash/` first. The retention setting controls when old files in that folder may later be removed.

Large-change protection is enabled by default at 50%. Before any sync mutation, Sync Save compares destructive changes with existing comparable paths. If the percentage is greater than the configured threshold, sync stops without changing local or cloud files. Set the threshold to `0` to disable this protection or `100` to allow any percentage; newly added files do not count toward the percentage.

### Google Drive recovery warning

If an earlier Google Drive version changed any file contents to `{}`, restore those files from an existing backup or Google Drive version history **before** re-enabling bidirectional sync. Bidirectional sync can otherwise propagate the damaged content to the other side.

## Development

```bash
git clone <repo>
cd sync-save
npm install
npm run dev
```

## Architecture

```
sync-save/
├── main.ts                 # Plugin entry point
├── styles.css              # Design system and UI styles
├── src/
│   ├── ui/
│   │   ├── SettingsTab.ts  # Settings panel UI
│   │   └── SyncStatusBar.ts# Status bar indicator
│   ├── providers/
│   │   ├── S3Provider.ts   # S3-compatible storage
│   │   ├── WebDAVProvider.ts # WebDAV protocol
│   │   ├── DropboxProvider.ts # Dropbox API
│   │   └── OneDriveProvider.ts # Microsoft Graph
│   └── sync/
│       ├── SyncService.ts  # Core sync engine
│       ├── CloudProvider.ts# Abstract provider interface
│       └── Encryption.ts   # AES-256-GCM encryption
├── manifest.json
├── package.json
├── tsconfig.json
└── esbuild.config.mjs
```

## License

MIT
