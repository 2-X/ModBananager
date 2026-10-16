# ModBananager

Electron GUI for browsing GameBanana, installing mods into the right folder for
the game they belong to, and managing what is installed. Also listens on
`http://localhost:3000/add-mod/<modId>` so a bookmarklet / curl can push a mod in;
a pushed id opens that mod's detail panel.

## UI

- **Sidebar**: the games from `games.json`. Selecting one scopes the rest of the
  window. `+` adds a game (GameBanana id, name via "Look up", layout, mod folder
  via a folder picker, title id for Ryujinx); the pencil edits or removes one.
  Both write back to `games.json`.
- **Browse**: GameBanana's mod index for the selected game as a card grid
  (thumbnail, author, version, likes, views, last update, category). Sort by
  most downloaded / liked / recently updated / newest / most viewed, or type in
  the search box (search results come back by relevance). Clicking a card opens
  the detail panel: stats, file list with an **Install** button per file,
  screenshots (click to enlarge) and the full description. Install is disabled
  when the mod's game is not in `games.json`; the panel offers to add it.
- **Installed**: the folders in the selected game's mod folder. For `modini`
  games each folder's `mod.ini` supplies name/author/version/description; for
  `ryujinx` it is just folder names. Open folder / Uninstall (asks first) per row.
- **SA Mod Manager profile**: for `modini` games that have
  `mods\.modloader\profiles\Profiles.json`, the active profile's `EnabledMods`
  and `ModsList` drive the enabled badge and the load order. The checkbox and
  the ▲▼ buttons write the file back: `ModsList` is every installed mod in
  order, `EnabledMods` is the enabled subset in that same order; only those two
  arrays are rewritten, the rest of the file is left byte for byte. Newly
  installed mods are appended to `ModsList` disabled; tick them to enable.
- **Install progress** shows in the footer (download bytes, extracting, placing)
  and the Installed tab refreshes when a mod lands.
- **Open mod by id** in the sidebar does the same as the `/add-mod/<id>` endpoint.

## Games

`games.json` maps a GameBanana game id to where its mods go:

| GameBanana id | Game | Layout | Mod folder |
|---|---|---|---|
| 5855 | Sonic Adventure 2 (Steam) | `modini` | `D:\SteamLibrary\steamapps\common\Sonic Adventure 2\mods` |
| 7617 | Ryujinx title `0100f2c0115b6000` | `ryujinx` | `%APPDATA%\Ryujinx\mods\contents\<titleId>` |

- `modini`: SA Mod Loader style. Every folder in the archive that has a `mod.ini`
  at its root is moved into the mod folder.
- `ryujinx`: finds the `romfs`/`exefs` folder and moves its parent's contents into
  `<modFolder>/<titleId>/<archive name>`.

Add more games from the UI or by adding entries. The mod's game id comes back
from the GameBanana API, so a mod for an unknown game cannot be installed until
its game is added.

Archives: on Windows, `C:\Windows\System32	ar.exe` (bsdtar) extracts zip, 7z and
rar. Other platforms fall back to adm-zip (zip) and node-unrar-js (rar); 7z needs
tar/bsdtar on PATH.

## Running

Needs Node (`winget install OpenJS.NodeJS.LTS` once). From this folder:

```bash
npm install
```

```bash
npm start
```

No build step; the renderer is plain HTML/CSS/JS (`index.html`, `styles.css`,
`renderer.js`) and loads nothing from the network except GameBanana data and
images. Environment variables:

- `MODBANANAGER_DEVTOOLS=1` opens the devtools pane on launch.
- `MODBANANAGER_PORT` changes the `/add-mod` listener port (default 3000).

Files: `main.js` (window, express listener, GameBanana fetch proxy, installed-mod
listing, profile read/write, download + extract + place), `preload.js` (the
`window.electron` bridge), `games.json` (game map).

## Sonic Adventure 2 setup (done 2026-10-16)

The Steam port's game logic is tied to the frame rate. In windowed mode nothing
caps it, so on a 143 Hz monitor it runs ~2.4x speed. The fix is the SA2 Mod Loader's
"Limit Framerate" patch, which is on by default. There is no real >60 fps mod; the
loader's InterpolationFixes only smooths animations that run below 60.

What is installed in `D:\SteamLibrary\steamapps\common\Sonic Adventure 2`:

- `SAModManager.exe` (X-Hax SA Mod Manager 1.3.7) with a `SAManager\` folder next to
  it. That folder makes it **portable**: config lives in `SAManager\Manager.json`,
  not in `%LOCALAPPDATA%`. This matters because anything run from Claude's tools
  sees a shadowed AppData; keeping it in the game folder sidesteps that.
- `mods\.modloader\` = SA2 Mod Loader release 332 (`SA2ModLoader.dll`, `Patches.json`,
  `Codes.lst`, `extlib\BASS`, `sa2mlver.txt`).
- `resource\gd_PC\DLL\Win32\Data_DLL.dll` is now the loader; the original is
  `Data_DLL_orig.dll` beside it (exactly what the manager's Install button does).
- `mods\.modloader\profiles\Default.json` (+ `Profiles.json`): borderless 2560x1440,
  skip intro, loader patches on **except `FramerateLimiter`** (Render Fix asks for it
  off because it ships its own frame controller + frameskip; it still caps at 60).
  Mod order: `sa2-render-fix`, `sasdl`, `sa2-input-controls`.
- `mods\sa2-render-fix\` = SA2 Render Fix v1.5.5.4 (GameBanana 452445). Keep it at
  the top of the mod order.
- `mods\sa2-input-controls\` = SA2 Input Controls v1.1.0.2 (GameBanana 515637),
  which Render Fix wants for its input fixes. It depends on
- `mods\sasdl\` = SASDL v1.0.0.0 (github shaddatic/sa2b-sdl-loader), SDL2 interface
  mod; must sit above Input Controls in the order.

To use: launch the game from Steam as usual (the loader is hooked in via Data_DLL),
or double-click `SAModManager.exe` to manage mods / launch. Run the manager once
normally so it registers the `sa2mm:` handler; after that GameBanana's
"1-Click Install" buttons on SA2 mods go straight into it. Steam's "verify
integrity" will restore the stock `Data_DLL.dll`; if that happens, open the
manager and press Install again (or re-copy `mods\.modloader\SA2ModLoader.dll`).

Popular SA2 GameBanana ids to try with this tool: 48872 Cutscene Revamp,
33171 HD GUI, 48874 No Model Tinting, 33169 Menu Overhaul, 33170 Character Select
PLUS, 313161 Better Radar, 48840 Chao World Extended.
