// ModBananager main process.
// Mods can also be pushed in from outside with `curl http://localhost:3000/add-mod/447188`.
// Which game a mod belongs to is read from GameBanana; games.json maps that
// game id to a mod folder + layout.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const { pipeline } = require('stream');
const { promisify } = require('util');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const streamPipeline = promisify(pipeline);
const tmp = require('tmp-promise');
const url = require('url');
const axios = require('axios');
const { createExtractorFromFile } = require('node-unrar-js');

const GAMES_PATH = path.join(__dirname, 'games.json');
const USER_AGENT = 'ModBananager';

// ---------------------------------------------------------------- games.json

function loadGames() {
  try {
    return fs.readJsonSync(GAMES_PATH);
  } catch (err) {
    console.error('games.json unreadable:', err);
    return {};
  }
}

// Only the real entries (games.json also carries a "_comment" key).
function gameEntries() {
  const all = loadGames();
  const out = {};
  for (const [id, g] of Object.entries(all)) {
    if (id.startsWith('_') || !g || typeof g !== 'object') continue;
    out[id] = g;
  }
  return out;
}

function saveGame(id, entry) {
  const all = loadGames();
  const clean = {
    name: String(entry.name || '').trim() || `Game ${id}`,
    layout: entry.layout === 'ryujinx' ? 'ryujinx' : 'modini',
    modFolder: String(entry.modFolder || '').trim(),
  };
  if (clean.layout === 'ryujinx') clean.titleId = String(entry.titleId || '').trim();
  all[String(id)] = clean;
  writeGames(all);
  return gameEntries();
}

// Keeps "_comment"-style keys at the top of the file. Written by hand because
// JSON.stringify always puts integer-like keys (the game ids) first.
function writeGames(all) {
  const keys = [...Object.keys(all).filter(k => k.startsWith('_')), ...Object.keys(all).filter(k => !k.startsWith('_'))];
  const body = keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(all[k], null, 2).replace(/\n/g, '\n  ')}`).join(',\n');
  fs.writeFileSync(GAMES_PATH, `{\n${body}\n}\n`);
}

function deleteGame(id) {
  const all = loadGames();
  delete all[String(id)];
  writeGames(all);
  return gameEntries();
}

// ---------------------------------------------------------------- express

const express = require('express');
const express_server = express();
const port = parseInt(process.env.MODBANANAGER_PORT || '3000', 10);

express_server.get('/add-mod/:modId', (req, res) => {
  const modId = req.params.modId;
  if (mainWindow) {
    mainWindow.webContents.send('add-mod', modId);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  res.send('Received modId: ' + modId);
});

express_server.listen(port, () => {
  console.log(`ModBananager listening at http://localhost:${port}`);
}).on('error', err => console.error('express:', err.message));

// ---------------------------------------------------------------- window

let mainWindow

app.on('ready', createWindow)

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
  if (mainWindow === null) createWindow()
})

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  mainWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, 'index.html'),
      protocol: 'file:',
      slashes: true,
    })
  )

  // Set MODBANANAGER_DEVTOOLS=1 to get the devtools pane on launch.
  if (process.env.MODBANANAGER_DEVTOOLS) mainWindow.webContents.openDevTools();

  // Links in mod descriptions open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith('file:')) { e.preventDefault(); shell.openExternal(target); }
  });

  mainWindow.on('closed', function () {
    mainWindow = null
  })
}

const send = (channel, payload) => { if (mainWindow) mainWindow.webContents.send(channel, payload); };

// ---------------------------------------------------------------- IPC: config + misc

ipcMain.handle('get-games', () => gameEntries());
ipcMain.handle('save-game', (e, id, entry) => saveGame(id, entry));
ipcMain.handle('delete-game', (e, id) => deleteGame(id));

ipcMain.handle('pick-folder', async (e, current) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: current && fs.existsSync(current) ? current : undefined,
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-path', (e, p) => shell.openPath(p));
ipcMain.handle('open-external', (e, target) => {
  if (/^https?:/i.test(target)) return shell.openExternal(target);
});

// GameBanana requests go through main so the renderer never fights CORS.
ipcMain.handle('gb-fetch', async (e, target) => {
  if (!/^https:\/\/gamebanana\.com\//.test(target)) throw new Error('refusing non-GameBanana url');
  const r = await axios.get(target, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: 20000 });
  return r.data;
});

// ---------------------------------------------------------------- IPC: installed mods

function parseIni(text) {
  // Flat key=value pairs before the first [section] (mod.ini keeps the mod's
  // metadata there); sections are ignored.
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// SA Mod Manager profile: mods/.modloader/profiles/Profiles.json names the active one.
function profilePath(game) {
  const dir = path.join(game.modFolder, '.modloader', 'profiles');
  let file = 'Default.json';
  try {
    const list = fs.readJsonSync(path.join(dir, 'Profiles.json'));
    const active = list.ProfilesList && list.ProfilesList[list.ProfileIndex || 0];
    if (active && active.Filename) file = active.Filename;
  } catch { /* no Profiles.json: fall back to Default.json */ }
  const p = path.join(dir, file);
  return fs.existsSync(p) ? p : null;
}

function readProfile(game) {
  const p = profilePath(game);
  if (!p) return null;
  try {
    const json = fs.readJsonSync(p);
    return { path: p, json };
  } catch (err) {
    console.error('profile unreadable:', err);
    return null;
  }
}

function listInstalled(gameId) {
  const game = gameEntries()[String(gameId)];
  if (!game) throw new Error(`unknown game ${gameId}`);
  const root = game.layout === 'ryujinx' ? path.join(game.modFolder, game.titleId || '') : game.modFolder;
  const result = { gameId, root, layout: game.layout, exists: fs.existsSync(root), mods: [], profile: null };
  if (!result.exists) return result;

  const folders = fs.readdirSync(root)
    .filter(f => !f.startsWith('.'))
    .filter(f => { try { return fs.lstatSync(path.join(root, f)).isDirectory(); } catch { return false; } });

  const mods = folders.map(folder => {
    const dir = path.join(root, folder);
    const mod = { folder, path: dir, name: folder, author: '', version: '', description: '', category: '' };
    if (game.layout === 'modini') {
      const ini = path.join(dir, 'mod.ini');
      if (fs.existsSync(ini)) {
        try {
          const kv = parseIni(fs.readFileSync(ini, 'utf8'));
          mod.name = kv.Name || folder;
          mod.author = kv.Author || '';
          mod.version = kv.Version || '';
          mod.description = kv.Description || '';
          mod.category = kv.Category || '';
          mod.hasIni = true;
        } catch { /* keep folder name */ }
      }
    }
    return mod;
  });

  if (game.layout === 'modini') {
    const prof = readProfile(game);
    if (prof) {
      const enabled = new Set(prof.json.EnabledMods || []);
      const order = prof.json.ModsList || prof.json.EnabledMods || [];
      const rank = new Map(order.map((f, i) => [f, i]));
      for (const m of mods) {
        m.enabled = enabled.has(m.folder);
        m.listed = rank.has(m.folder);
      }
      // Profile order first, then anything the manager hasn't seen yet (alphabetical).
      mods.sort((a, b) => {
        const ra = rank.has(a.folder) ? rank.get(a.folder) : 1e9;
        const rb = rank.has(b.folder) ? rank.get(b.folder) : 1e9;
        return ra - rb || a.folder.localeCompare(b.folder);
      });
      result.profile = { path: prof.path, enabledCount: mods.filter(m => m.enabled).length };
    } else {
      mods.sort((a, b) => a.folder.localeCompare(b.folder));
    }
  } else {
    mods.sort((a, b) => a.folder.localeCompare(b.folder));
  }
  result.mods = mods;
  return result;
}

ipcMain.handle('list-installed', (e, gameId) => listInstalled(gameId));

// Writes ModsList (every installed mod, in order) and EnabledMods (the enabled
// subset, in that same order) back into the active profile. Everything else in
// the file is left untouched.
function writeProfileOrder(game, order, enabledSet) {
  const prof = readProfile(game);
  if (!prof) throw new Error('no SA Mod Manager profile found under ' + game.modFolder);
  const modsList = order.slice();
  const enabledMods = order.filter(f => enabledSet.has(f));

  // Prefer swapping just the two arrays inside the original text so the rest
  // of the file (number formatting like 0.0, key order) is untouched.
  const text = fs.readFileSync(prof.path, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fmt = (arr) => arr.length ? `[${eol}    ` + arr.map(v => JSON.stringify(v)).join(`,${eol}    `) + `${eol}  ]` : '[]';
  const swap = (src, key, arr) => {
    const re = new RegExp(`("${key}"\\s*:\\s*)\\[[^\\]]*\\]`);
    return re.test(src) ? src.replace(re, (m, head) => head + fmt(arr)) : null;
  };
  const safe = [...modsList, ...(prof.json.ModsList || []), ...(prof.json.EnabledMods || [])].every(f => !String(f).includes(']'));
  let out = safe ? swap(text, 'EnabledMods', enabledMods) : null;
  if (out) out = swap(out, 'ModsList', modsList);
  if (out) {
    try {
      const check = JSON.parse(out);
      if (JSON.stringify(check.ModsList) === JSON.stringify(modsList) && JSON.stringify(check.EnabledMods) === JSON.stringify(enabledMods)) {
        fs.writeFileSync(prof.path, out);
        return;
      }
    } catch { /* fall through to full rewrite */ }
  }
  prof.json.ModsList = modsList;
  prof.json.EnabledMods = enabledMods;
  fs.writeJsonSync(prof.path, prof.json, { spaces: 2 });
}

// order: array of folder names (full desired load order); enabled: array of folder names.
ipcMain.handle('set-mod-order', (e, gameId, order, enabled) => {
  const game = gameEntries()[String(gameId)];
  if (!game || game.layout !== 'modini') throw new Error('load order only applies to modini games');
  const present = new Set(listInstalled(gameId).mods.map(m => m.folder));
  const cleanOrder = order.filter(f => present.has(f));
  for (const f of present) if (!cleanOrder.includes(f)) cleanOrder.push(f);
  const enabledSet = new Set(enabled);
  // Entries the profile lists but that are missing on disk are kept (appended),
  // so a folder someone moved away temporarily is not silently forgotten.
  const prof = readProfile(game);
  if (prof) {
    for (const f of prof.json.ModsList || []) if (!cleanOrder.includes(f)) cleanOrder.push(f);
    for (const f of prof.json.EnabledMods || []) if (!present.has(f)) enabledSet.add(f);
  }
  writeProfileOrder(game, cleanOrder, enabledSet);
  return listInstalled(gameId);
});

ipcMain.handle('uninstall-mod', async (e, gameId, folder) => {
  const info = listInstalled(gameId);
  const mod = info.mods.find(m => m.folder === folder);
  if (!mod) throw new Error(`${folder} is not installed`);
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Uninstall mod',
    message: `Delete "${mod.name}"?`,
    detail: `This removes the folder\n${mod.path}\nand cannot be undone.`,
  });
  if (r.response !== 0) return { cancelled: true };
  // Refuse anything that is not a direct child of the mod root.
  const rel = path.relative(info.root, mod.path);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) throw new Error('refusing to delete outside the mod folder');
  fs.removeSync(mod.path);
  const game = gameEntries()[String(gameId)];
  if (game.layout === 'modini') {
    const prof = readProfile(game);
    if (prof) {
      const order = (prof.json.ModsList || []).filter(f => f !== folder);
      const enabled = new Set((prof.json.EnabledMods || []).filter(f => f !== folder));
      writeProfileOrder(game, order, enabled);
    }
  }
  return listInstalled(gameId);
});

// ---------------------------------------------------------------- extraction + placement

// Windows ships libarchive's bsdtar, which reads zip, 7z and rar. Prefer it;
// fall back to adm-zip / node-unrar-js elsewhere.
function extractArchive(archivePath, destDir) {
  fs.ensureDirSync(destDir);
  const ext = path.extname(archivePath).toLowerCase();

  if (process.platform === 'win32') {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tarExe)) {
      const r = spawnSync(tarExe, ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
      if (r.status === 0) return;
      console.warn(`tar.exe failed (${r.status}) on ${archivePath}, trying JS fallback`);
    }
  }

  if (ext === '.zip') {
    new AdmZip(archivePath).extractAllTo(destDir, true);
  } else if (ext === '.rar') {
    return createExtractorFromFile({ filepath: archivePath, targetPath: destDir })
      .then(extractor => { [...extractor.extract().files]; });
  } else {
    throw new Error(`No extractor available for ${ext} on this platform (install 7-Zip and add it to PATH, or run on Windows)`);
  }
}

const moveContentsToTarget = (sourceDir, targetDir) => {
  fs.ensureDirSync(targetDir);
  for (const file of fs.readdirSync(sourceDir)) {
    fs.moveSync(path.join(sourceDir, file), path.join(targetDir, file), { overwrite: true });
  }
}

// Ryujinx: find the folder that holds romfs/exefs and move its siblings into <modFolder>/<titleId>/<modName>.
function placeRyujinx(extractedDir, game, modName) {
  const target = path.join(game.modFolder, game.titleId, modName);
  const findAndMove = (currentDir) => {
    for (const file of fs.readdirSync(currentDir)) {
      const currentPath = path.join(currentDir, file);
      if (!fs.lstatSync(currentPath).isDirectory()) continue;
      if (file === 'romfs' || file === 'exefs') {
        moveContentsToTarget(path.dirname(currentPath), target);
        return true;
      }
      if (findAndMove(currentPath)) return true;
    }
    return false;
  }
  if (!findAndMove(extractedDir)) {
    // no romfs/exefs found; keep whatever was in the archive
    moveContentsToTarget(extractedDir, target);
  }
  return target;
}

// SA Mod Loader (SADX/SA2): every mod is a folder with a mod.ini at its root.
// Find each mod.ini in the archive and move its folder into <modFolder>/<folderName>.
function placeModIni(extractedDir, game, modName) {
  const placed = [];
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, 'mod.ini'))) {
      const folderName = dir === extractedDir ? modName : path.basename(dir);
      const target = path.join(game.modFolder, folderName);
      fs.removeSync(target);
      fs.moveSync(dir, target, { overwrite: true });
      placed.push(target);
      return;
    }
    if (depth > 6) return;
    for (const file of fs.readdirSync(dir)) {
      const p = path.join(dir, file);
      if (fs.lstatSync(p).isDirectory()) walk(p, depth + 1);
    }
  }
  walk(extractedDir, 0);
  if (placed.length === 0) {
    // No mod.ini anywhere: drop the archive contents in as-is so nothing is lost.
    const target = path.join(game.modFolder, modName);
    moveContentsToTarget(extractedDir, target);
    placed.push(target);
  }
  return placed;
}

// Newly placed modini mods get appended to the profile's ModsList (disabled)
// so they show up in the load order right away.
function registerInProfile(game, placed) {
  if (game.layout !== 'modini') return;
  const prof = readProfile(game);
  if (!prof) return;
  const order = (prof.json.ModsList || []).slice();
  let changed = false;
  for (const p of placed) {
    const folder = path.basename(p);
    if (!order.includes(folder)) { order.push(folder); changed = true; }
  }
  if (changed) writeProfileOrder(game, order, new Set(prof.json.EnabledMods || []));
}

// jobId lets the renderer match progress events to the button that started them.
ipcMain.on('download-and-unzip', async (event, dlUrl, gameId, modName, jobId) => {
  const game = gameEntries()[String(gameId)];
  const progress = (payload) => send('install-progress', { jobId, gameId, modName, ...payload });
  if (!game) {
    const error = `No entry for GameBanana game ${gameId} in games.json; add one.`;
    console.error(error);
    send('mod-installed', { jobId, gameId, modName, error });
    return;
  }

  const tmpfile = await tmp.file({ postfix: path.extname(modName) });
  const tmpdir = await tmp.dir({ unsafeCleanup: true });

  try {
    progress({ phase: 'downloading', received: 0, total: 0 });
    const response = await axios.get(dlUrl, { responseType: 'stream', headers: { 'User-Agent': USER_AGENT } });
    const total = parseInt(response.headers['content-length'] || '0', 10);
    let received = 0, lastSent = 0;
    response.data.on('data', chunk => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastSent > 100) { lastSent = now; progress({ phase: 'downloading', received, total }); }
    });
    await streamPipeline(response.data, fs.createWriteStream(tmpfile.path));
    progress({ phase: 'extracting', received, total });

    const modNameWithoutExtension = modName.slice(0, modName.lastIndexOf('.'));
    await extractArchive(tmpfile.path, tmpdir.path);
    progress({ phase: 'placing', received, total });

    let placed;
    if (game.layout === 'ryujinx') placed = placeRyujinx(tmpdir.path, game, modNameWithoutExtension);
    else placed = placeModIni(tmpdir.path, game, modNameWithoutExtension);
    placed = [].concat(placed);
    registerInProfile(game, placed);

    console.log(`[${game.name}] installed ${modName} ->`, placed);
    send('mod-installed', { jobId, gameId, modName, placed });
  } catch (err) {
    console.error(`failed to install ${modName}:`, err && err.message || err);
    send('mod-installed', { jobId, gameId, modName, error: String(err && err.message || err) });
  } finally {
    await tmpfile.cleanup();
    await tmpdir.cleanup();
  }
});
