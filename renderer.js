// ModBananager renderer. Vanilla JS; talks to main through window.electron / window.api (preload.js).

const $ = (sel) => document.querySelector(sel);
const PER_PAGE = 30;

const state = {
  games: {},                 // gameId -> { name, layout, modFolder, titleId }
  gameId: localStorage.getItem('gameId') || null,
  view: 'browse',
  sort: localStorage.getItem('sort') || 'Generic_MostDownloaded',
  query: '',
  page: 1,
  total: 0,
  perPage: PER_PAGE,
  browseSeq: 0,              // ignore stale fetches
  installed: null,           // result of list-installed for the selected game
  detail: null,              // ProfilePage json currently shown
  jobs: new Map(),           // jobId -> job
};

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

const fmtNum = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};
const fmtBytes = (b) => {
  b = Number(b) || 0;
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + ' GB';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(0) + ' KB';
  return b + ' B';
};
const fmtDate = (ts) => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '';
const fmtVersion = (v) => v ? 'v' + String(v).replace(/^v/i, '') : '';
const latest = (...ts) => Math.max(0, ...ts.map(t => Number(t) || 0)) || null;
const fmtAgo = (ts) => {
  if (!ts) return '';
  const s = Date.now() / 1000 - ts;
  const units = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [sec, label] of units) if (s >= sec) return Math.floor(s / sec) + label + ' ago';
  return 'just now';
};

// Picks the best available rendition of a GameBanana preview image.
function imageUrl(img, preferred = ['_sFile530', '_sFile220', '_sFile800', '_sFile100', '_sFile']) {
  if (!img || !img._sBaseUrl) return null;
  for (const k of preferred) if (img[k]) return `${img._sBaseUrl}/${img[k]}`;
  return null;
}
function firstImage(mod, preferred) {
  const imgs = mod && mod._aPreviewMedia && mod._aPreviewMedia._aImages;
  return Array.isArray(imgs) && imgs.length ? imageUrl(imgs[0], preferred) : null;
}
function thumbEl(src, name, extraClass = '') {
  const t = el('div', { class: 'thumb ' + extraClass });
  if (src) {
    const img = el('img', { src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => { img.remove(); t.textContent = (name || '?').slice(0, 1).toUpperCase(); });
    t.appendChild(img);
  } else {
    t.textContent = (name || '?').slice(0, 1).toUpperCase();
  }
  return t;
}

function toast(msg, kind = '') {
  const t = el('div', { class: 'toast ' + kind, text: msg });
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4500);
}

// Only mod descriptions use innerHTML; strip anything that could run.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || (name === 'href' || name === 'src') && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
    if (n.tagName === 'A') n.setAttribute('href', n.getAttribute('href') || '#');
  });
  return doc.body.innerHTML;
}

const gb = (path) => window.electron.gbFetch('https://gamebanana.com/apiv11/' + path);
const currentGame = () => state.games[state.gameId] || null;

// ---------------------------------------------------------------- games sidebar

async function loadGames() {
  state.games = await window.electron.getGames();
  const ids = Object.keys(state.games);
  if (!ids.includes(state.gameId)) state.gameId = ids[0] || null;
  renderGameList();
  onGameChanged();
}

function renderGameList() {
  const list = $('#gameList');
  list.innerHTML = '';
  const ids = Object.keys(state.games);
  if (!ids.length) {
    list.appendChild(el('li', { class: 'empty', text: 'No games yet. Press + to add one.' }));
    return;
  }
  for (const id of ids) {
    const g = state.games[id];
    const li = el('li', { class: 'game-item' + (id === state.gameId ? ' active' : ''), title: `${g.modFolder}\nGameBanana game ${id}` },
      el('div', { class: 'name', text: g.name || `Game ${id}` }),
      el('button', { class: 'icon-btn edit', title: 'Edit', onclick: (e) => { e.stopPropagation(); openGameDialog(id); } }, '✎'),
      el('div', { class: 'sub' }, el('span', { class: 'badge', text: g.layout }), el('span', { text: g.modFolder || '(no folder)' })),
    );
    li.addEventListener('click', () => { if (state.gameId !== id) { state.gameId = id; renderGameList(); onGameChanged(); } });
    list.appendChild(li);
  }
}

function onGameChanged() {
  localStorage.setItem('gameId', state.gameId || '');
  const g = currentGame();
  $('#gameMeta').textContent = g ? `${g.name} · GameBanana #${state.gameId} · ${g.layout}` : '';
  state.page = 1;
  state.installed = null;
  $('#installedCount').textContent = '';
  if (g) {
    loadBrowse();
    loadInstalled();
  } else {
    $('#modGrid').innerHTML = '';
    $('#browseStatus').textContent = 'Add a game to start browsing.';
    $('#installedList').innerHTML = '';
    $('#installedPath').textContent = '';
    $('#pager').classList.add('hidden');
  }
}

// ---------------------------------------------------------------- browse

let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    state.page = 1;
    loadBrowse();
  }, 300);
});
$('#sortSelect').value = state.sort;
$('#sortSelect').addEventListener('change', (e) => {
  state.sort = e.target.value;
  localStorage.setItem('sort', state.sort);
  state.page = 1;
  loadBrowse();
});
$('#prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadBrowse(); } });
$('#nextPage').addEventListener('click', () => { state.page++; loadBrowse(); });

async function loadBrowse() {
  const g = currentGame();
  if (!g) return;
  const seq = ++state.browseSeq;
  const status = $('#browseStatus');
  status.className = 'status-line';
  status.textContent = state.query ? `Searching “${state.query}”…` : 'Loading…';
  $('#sortSelect').disabled = !!state.query;
  try {
    let records, total, perPage;
    if (state.query) {
      const q = encodeURIComponent(state.query);
      const data = await gb(`Util/Search/Results?_sSearchString=${q}&_idGameRow=${state.gameId}&_sModelName=Mod&_nPage=${state.page}`);
      records = (data._aRecords || []).filter(r => r._sModelName === 'Mod');
      total = (data._aMetadata && data._aMetadata._nRecordCount) || records.length;
      perPage = (data._aMetadata && data._aMetadata._nPerpage) || records.length || 15;
    } else {
      const data = await gb(`Mod/Index?_nPerpage=${PER_PAGE}&_nPage=${state.page}&_aFilters[Generic_Game]=${state.gameId}&_sSort=${state.sort}`);
      records = data._aRecords || [];
      total = (data._aMetadata && data._aMetadata._nRecordCount) || records.length;
      perPage = (data._aMetadata && data._aMetadata._nPerpage) || PER_PAGE;
    }
    if (seq !== state.browseSeq) return;
    state.total = total; state.perPage = perPage;
    renderGrid(records);
    const pages = Math.max(1, Math.ceil(total / perPage));
    status.textContent = records.length
      ? `${fmtNum(total)} mods${state.query ? ' match (sorted by relevance)' : ''} · page ${state.page} of ${pages}`
      : (state.query ? 'No mods match.' : 'GameBanana returned no mods for this game id.');
    $('#pager').classList.toggle('hidden', pages <= 1);
    $('#pageInfo').textContent = `${state.page} / ${pages}`;
    $('#prevPage').disabled = state.page <= 1;
    $('#nextPage').disabled = state.page >= pages;
    $('#view-browse').scrollTop = 0;
  } catch (err) {
    if (seq !== state.browseSeq) return;
    status.className = 'status-line bad';
    status.textContent = 'GameBanana request failed: ' + (err.message || err);
    $('#modGrid').innerHTML = '';
  }
}

function renderGrid(records) {
  const grid = $('#modGrid');
  grid.innerHTML = '';
  for (const r of records) {
    const cat = (r._aRootCategory && r._aRootCategory._sName) || (r._aCategory && r._aCategory._sName) || '';
    const author = (r._aSubmitter && r._aSubmitter._sName) || 'unknown';
    const updated = latest(r._tsDateUpdated, r._tsDateModified, r._tsDateAdded);
    const thumb = thumbEl(firstImage(r, ['_sFile220', '_sFile530', '_sFile100', '_sFile']), r._sName);
    if (cat) thumb.appendChild(el('span', { class: 'cat', text: cat }));
    const card = el('div', { class: 'card', title: r._sName || '' },
      thumb,
      el('div', { class: 'card-body' },
        el('div', { class: 'title', text: r._sName || `Mod ${r._idRow}` }),
        el('div', { class: 'by', text: 'by ' + author + (r._sVersion ? ` · ${fmtVersion(r._sVersion)}` : '') }),
        el('div', { class: 'stats' },
          el('span', { title: 'Likes', text: '♥ ' + fmtNum(r._nLikeCount) }),
          r._nDownloadCount != null ? el('span', { title: 'Downloads', text: '⇩ ' + fmtNum(r._nDownloadCount) }) : el('span', { title: 'Views', text: '👁 ' + fmtNum(r._nViewCount) }),
          el('span', { title: 'Updated ' + fmtDate(updated), text: '↻ ' + fmtAgo(updated) }),
        ),
      ),
    );
    card.addEventListener('click', () => openDetail(r._idRow));
    grid.appendChild(card);
  }
}

// ---------------------------------------------------------------- detail panel

async function openDetail(modId) {
  modId = String(modId || '').trim().replace(/\D/g, '');
  if (!modId) return;
  const body = $('#detailBody');
  body.innerHTML = '';
  body.appendChild(el('div', { class: 'status-line', text: `Loading mod ${modId}…` }));
  $('#detailOverlay').classList.remove('hidden');
  let mod;
  try {
    mod = await gb(`Mod/${modId}/ProfilePage`);
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'status-line bad', text: `Could not load mod ${modId}: ${err.message || err}` }));
    return;
  }
  state.detail = mod;
  renderDetail(mod);
}

function closeDetail() { $('#detailOverlay').classList.add('hidden'); state.detail = null; }
$('#detailClose').addEventListener('click', closeDetail);
$('#detailOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDetail(); });

function renderDetail(mod) {
  const body = $('#detailBody');
  body.innerHTML = '';
  const modGameId = mod._aGame && mod._aGame._idRow != null ? String(mod._aGame._idRow) : null;
  const modGameName = (mod._aGame && mod._aGame._sName) || 'unknown game';
  const target = modGameId ? state.games[modGameId] : null;
  const author = (mod._aSubmitter && mod._aSubmitter._sName) || 'unknown';
  const images = (mod._aPreviewMedia && Array.isArray(mod._aPreviewMedia._aImages)) ? mod._aPreviewMedia._aImages : [];
  const files = Array.isArray(mod._aFiles) ? mod._aFiles : [];
  const cat = (mod._aCategory && mod._aCategory._sName) || '';

  const targetLine = target
    ? el('div', { class: 'target' }, el('span', { class: 'badge ok', text: '→ ' + target.name }), ' ', el('code', { text: target.layout === 'ryujinx' ? `${target.modFolder}\\${target.titleId || ''}` : target.modFolder }))
    : el('div', { class: 'target' }, el('span', { class: 'badge bad', text: `${modGameName} (#${modGameId}) is not in games.json` }), ' ',
        modGameId ? el('button', { class: 'btn small', onclick: () => openGameDialog(null, { id: modGameId, name: modGameName }) }, 'Add game') : null);

  body.appendChild(el('div', { class: 'detail-hero' },
    thumbEl(firstImage(mod), mod._sName),
    el('div', {},
      el('h1', { text: mod._sName || `Mod ${mod._idRow}` }),
      el('div', { class: 'by' }, 'by ' + author, mod._sVersion ? ` · ${fmtVersion(mod._sVersion)}` : '', cat ? ` · ${cat}` : ''),
      el('div', { class: 'stats' },
        el('span', {}, el('b', { text: fmtNum(mod._nLikeCount) }), ' likes'),
        el('span', {}, el('b', { text: fmtNum(mod._nDownloadCount) }), ' downloads'),
        el('span', {}, el('b', { text: fmtNum(mod._nViewCount) }), ' views'),
        el('span', { title: fmtDate(latest(mod._tsDateUpdated, mod._tsDateModified)) }, 'updated ', el('b', { text: fmtAgo(latest(mod._tsDateUpdated, mod._tsDateModified)) })),
        el('span', { title: fmtDate(mod._tsDateAdded) }, 'added ', el('b', { text: fmtDate(mod._tsDateAdded) })),
      ),
      el('div', { class: 'tags' },
        mod._bIsObsolete ? el('span', { class: 'badge warn', text: 'obsolete' }) : null,
        (Array.isArray(mod._aTags) ? mod._aTags : []).slice(0, 6).map(t => el('span', { class: 'badge', text: typeof t === 'string' ? t : (t && t._sTitle) || '' })),
      ),
      targetLine,
      el('div', { class: 'detail-links', style: 'margin-top:8px' },
        el('button', { class: 'btn small', onclick: () => window.electron.openExternal(mod._sProfileUrl || `https://gamebanana.com/mods/${mod._idRow}`) }, 'Open on GameBanana'),
      ),
    ),
  ));

  if (mod._sDescription) body.appendChild(el('div', { class: 'desc', text: mod._sDescription }));

  // Files
  const filesSec = el('div', { class: 'detail-section' }, el('h3', { text: `Files (${files.length})` }));
  const list = el('div', { class: 'files' });
  if (!files.length) list.appendChild(el('div', { class: 'status-line', text: 'This mod has no downloadable files.' }));
  for (const f of files) {
    const name = f._sFile || `file ${f._idRow}`;
    const meta = [fmtBytes(f._nFilesize), f._nDownloadCount != null ? fmtNum(f._nDownloadCount) + ' dl' : '', fmtDate(f._tsDateAdded), f._sAvResult && f._sAvResult !== 'clean' ? `AV: ${f._sAvResult}` : ''].filter(Boolean).join(' · ');
    const btn = el('button', { class: 'btn primary small', disabled: !target || !f._sDownloadUrl, title: target ? `Install into ${target.name}` : 'Add this game to games.json first' }, 'Install');
    btn.addEventListener('click', () => startInstall(f._sDownloadUrl, modGameId, name, btn));
    list.appendChild(el('div', { class: 'file' },
      el('div', { class: 'fname', text: name }),
      btn,
      el('div', { class: 'fmeta', text: meta }),
      f._sDescription ? el('div', { class: 'fdesc', text: f._sDescription }) : null,
    ));
  }
  filesSec.appendChild(list);
  body.appendChild(filesSec);

  // Screenshots
  if (images.length) {
    const shots = el('div', { class: 'shots' });
    for (const img of images) {
      const small = imageUrl(img, ['_sFile220', '_sFile100', '_sFile530', '_sFile']);
      const big = imageUrl(img, ['_sFile800', '_sFile530', '_sFile', '_sFile220']);
      if (!small) continue;
      const i = el('img', { src: small, alt: img._sCaption || '', title: img._sCaption || '', loading: 'lazy' });
      i.addEventListener('error', () => i.remove());
      i.addEventListener('click', () => { $('#lightboxImg').src = big || small; $('#lightbox').classList.remove('hidden'); });
      shots.appendChild(i);
    }
    body.appendChild(el('div', { class: 'detail-section' }, el('h3', { text: `Screenshots (${images.length})` }), shots));
  }

  // Full description
  if (mod._sText) {
    const d = el('div', { class: 'desc', html: sanitizeHtml(mod._sText) });
    d.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) window.electron.openExternal(href);
    });
    body.appendChild(el('div', { class: 'detail-section' }, el('h3', { text: 'Description' }), d));
  }
  body.scrollTop = 0;
}

$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));

// ---------------------------------------------------------------- install jobs

function startInstall(dlUrl, gameId, fileName, btn) {
  const jobId = window.electron.downloadAndUnzip(dlUrl, gameId, fileName);
  const job = { jobId, gameId, fileName, btn, phase: 'queued', received: 0, total: 0 };
  state.jobs.set(jobId, job);
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  renderJobs();
}

function renderJobs() {
  const foot = $('#jobs');
  foot.innerHTML = '';
  const jobs = [...state.jobs.values()].slice(-6);
  foot.classList.toggle('hidden', jobs.length === 0);
  for (const j of jobs) {
    const g = state.games[j.gameId];
    let stateText, pct = 0;
    if (j.phase === 'downloading') {
      pct = j.total ? Math.round(j.received / j.total * 100) : 0;
      stateText = j.total ? `downloading ${fmtBytes(j.received)} / ${fmtBytes(j.total)} (${pct}%)` : `downloading ${fmtBytes(j.received)}`;
    } else if (j.phase === 'extracting') { pct = 100; stateText = 'extracting…'; }
    else if (j.phase === 'placing') { pct = 100; stateText = 'placing files…'; }
    else if (j.phase === 'done') stateText = 'installed → ' + (j.placed || []).map(p => p.split(/[\\/]/).pop()).join(', ');
    else if (j.phase === 'failed') stateText = 'failed: ' + j.error;
    else stateText = 'queued';
    const row = el('div', { class: 'job ' + j.phase },
      el('div', { class: 'label', text: `${g ? g.name + ' · ' : ''}${j.fileName}` }),
      el('div', { class: 'state', text: stateText }),
      el('div', { class: 'bar' }, el('div', { style: `width:${pct}%` })),
    );
    if (j.phase === 'done' || j.phase === 'failed') {
      const dismiss = el('button', { class: 'icon-btn', title: 'Dismiss', onclick: () => { state.jobs.delete(j.jobId); renderJobs(); } }, '✕');
      row.querySelector('.state').appendChild(dismiss);
    }
    foot.appendChild(row);
  }
}

window.api.receive('install-progress', (p) => {
  const j = state.jobs.get(p.jobId);
  if (!j) return;
  j.phase = p.phase; j.received = p.received || 0; j.total = p.total || 0;
  renderJobs();
});

window.api.receive('mod-installed', (info) => {
  const j = state.jobs.get(info.jobId) || { jobId: info.jobId || Date.now(), gameId: info.gameId, fileName: info.modName };
  state.jobs.set(j.jobId, j);
  if (info.error) {
    j.phase = 'failed'; j.error = info.error;
    if (j.btn) { j.btn.disabled = false; j.btn.textContent = 'Retry'; }
    toast(`Failed to install ${info.modName}: ${info.error}`, 'bad');
  } else {
    j.phase = 'done'; j.placed = [].concat(info.placed || []);
    if (j.btn) { j.btn.disabled = false; j.btn.textContent = 'Installed ✓'; }
    toast(`Installed ${info.modName}`, 'ok');
    if (String(info.gameId) === String(state.gameId)) loadInstalled();
  }
  renderJobs();
});

// ---------------------------------------------------------------- installed view

$('#refreshInstalledBtn').addEventListener('click', loadInstalled);
$('#openModFolderBtn').addEventListener('click', () => {
  const root = state.installed && state.installed.root;
  if (root) window.electron.openPath(root);
});

async function loadInstalled() {
  const g = currentGame();
  if (!g) return;
  const gameId = state.gameId;
  const status = $('#installedStatus');
  status.className = 'status-line';
  try {
    const info = await window.electron.listInstalled(gameId);
    if (gameId !== state.gameId) return;
    state.installed = info;
    renderInstalled(info);
  } catch (err) {
    status.className = 'status-line bad';
    status.textContent = 'Could not read mod folder: ' + (err.message || err);
  }
}

function renderInstalled(info) {
  const g = currentGame();
  const status = $('#installedStatus');
  const list = $('#installedList');
  list.innerHTML = '';
  $('#installedPath').textContent = info.root || '';
  $('#installedCount').textContent = info.mods.length ? `(${info.mods.length})` : '';
  $('#openModFolderBtn').disabled = !info.exists;

  if (!info.exists) {
    status.className = 'status-line bad';
    status.textContent = 'Mod folder does not exist yet. It is created on the first install, or fix the path via the game’s ✎ button.';
    return;
  }
  const hasProfile = !!info.profile;
  status.className = 'status-line';
  if (!info.mods.length) status.textContent = 'No mods installed. Browse and press Install on a file.';
  else if (hasProfile) status.textContent = `${info.profile.enabledCount} of ${info.mods.length} enabled · load order from ${info.profile.path.split(/[\\/]/).slice(-3).join('\\')} (top loads first)`;
  else if (g.layout === 'modini') status.textContent = `${info.mods.length} mod folders · no SA Mod Manager profile found, so enable/disable is unavailable`;
  else status.textContent = `${info.mods.length} mod folders`;

  info.mods.forEach((m, idx) => {
    const row = el('div', { class: 'mod-row' + (hasProfile ? (m.enabled ? '' : ' disabled') : ' no-profile') });
    if (hasProfile) {
      row.appendChild(el('div', { class: 'order', text: String(idx + 1) }));
      const cb = el('input', { type: 'checkbox', title: m.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable' });
      cb.checked = !!m.enabled;
      cb.addEventListener('change', () => setEnabled(m.folder, cb.checked));
      row.appendChild(cb);
    }
    const metaBits = [m.author ? 'by ' + m.author : '', m.category, m.folder !== m.name ? m.folder : ''].filter(Boolean);
    row.appendChild(el('div', { class: 'main' },
      el('div', { class: 'line' },
        el('span', { class: 'name', text: m.name }),
        m.version ? el('span', { class: 'ver', text: fmtVersion(m.version) }) : null,
        hasProfile ? el('span', { class: 'badge ' + (m.enabled ? 'ok' : 'off'), text: m.enabled ? 'enabled' : 'disabled' }) : null,
        hasProfile && !m.listed ? el('span', { class: 'badge warn', title: 'Not yet in the profile’s ModsList; the manager has not seen it', text: 'new' }) : null,
        g.layout === 'modini' && !m.hasIni ? el('span', { class: 'badge warn', title: 'No mod.ini at the folder root; the loader will ignore it', text: 'no mod.ini' }) : null,
      ),
      metaBits.length ? el('div', { class: 'meta', text: metaBits.join(' · ') }) : null,
      m.description ? el('div', { class: 'desc', title: m.description, text: m.description }) : null,
    ));
    const actions = el('div', { class: 'actions' });
    if (hasProfile) {
      actions.appendChild(el('div', { class: 'move' },
        el('button', { class: 'icon-btn', title: 'Move up', disabled: idx === 0, onclick: () => moveMod(idx, -1) }, '▲'),
        el('button', { class: 'icon-btn', title: 'Move down', disabled: idx === info.mods.length - 1, onclick: () => moveMod(idx, 1) }, '▼'),
      ));
    }
    actions.appendChild(el('button', { class: 'btn small', title: m.path, onclick: () => window.electron.openPath(m.path) }, 'Open folder'));
    actions.appendChild(el('button', { class: 'btn small danger', onclick: () => uninstall(m) }, 'Uninstall'));
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function writeOrder(order, enabled) {
  try {
    const info = await window.electron.setModOrder(state.gameId, order, enabled);
    state.installed = info;
    renderInstalled(info);
  } catch (err) {
    toast('Could not write profile: ' + (err.message || err), 'bad');
    loadInstalled();
  }
}

function setEnabled(folder, on) {
  const mods = state.installed.mods;
  const order = mods.map(m => m.folder);
  const enabled = mods.filter(m => m.folder === folder ? on : m.enabled).map(m => m.folder);
  writeOrder(order, enabled);
}

function moveMod(idx, delta) {
  const mods = state.installed.mods.slice();
  const to = idx + delta;
  if (to < 0 || to >= mods.length) return;
  [mods[idx], mods[to]] = [mods[to], mods[idx]];
  writeOrder(mods.map(m => m.folder), mods.filter(m => m.enabled).map(m => m.folder));
}

async function uninstall(m) {
  try {
    const info = await window.electron.uninstallMod(state.gameId, m.folder);
    if (info && info.cancelled) return;
    state.installed = info;
    renderInstalled(info);
    toast(`Removed ${m.name}`, 'ok');
  } catch (err) {
    toast('Uninstall failed: ' + (err.message || err), 'bad');
  }
}

// ---------------------------------------------------------------- game dialog

let editingGameId = null;

function openGameDialog(id, prefill) {
  editingGameId = id;
  const g = id ? state.games[id] : null;
  $('#gameFormTitle').textContent = id ? 'Edit game' : 'Add game';
  $('#gfId').value = id || (prefill && prefill.id) || '';
  $('#gfId').disabled = !!id;
  $('#gfName').value = g ? g.name : (prefill && prefill.name) || '';
  $('#gfLayout').value = g ? g.layout : 'modini';
  $('#gfFolder').value = g ? g.modFolder : '';
  $('#gfTitleId').value = g ? (g.titleId || '') : '';
  $('#gfError').textContent = '';
  $('#gfDelete').classList.toggle('hidden', !id);
  syncLayoutFields();
  $('#gameDialog').classList.remove('hidden');
  (id ? $('#gfName') : $('#gfId')).focus();
}
function closeGameDialog() { $('#gameDialog').classList.add('hidden'); }
function syncLayoutFields() { $('#gfTitleIdRow').classList.toggle('hidden', $('#gfLayout').value !== 'ryujinx'); }

$('#addGameBtn').addEventListener('click', () => openGameDialog(null));
$('#gfCancel').addEventListener('click', closeGameDialog);
$('#gameDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeGameDialog(); });
$('#gfLayout').addEventListener('change', syncLayoutFields);
$('#gfBrowse').addEventListener('click', async () => {
  const picked = await window.electron.pickFolder($('#gfFolder').value);
  if (picked) $('#gfFolder').value = picked;
});
$('#gfLookup').addEventListener('click', async () => {
  const id = $('#gfId').value.trim().replace(/\D/g, '');
  if (!id) { $('#gfError').textContent = 'Enter a game id first.'; return; }
  $('#gfError').textContent = '';
  try {
    const game = await gb(`Game/${id}/ProfilePage`);
    if (game && game._sName) $('#gfName').value = game._sName;
    else $('#gfError').textContent = 'No game with that id.';
  } catch (err) {
    $('#gfError').textContent = 'Lookup failed: ' + (err.message || err);
  }
});
$('#gameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = (editingGameId || $('#gfId').value).trim().replace(/\D/g, '');
  const entry = {
    name: $('#gfName').value,
    layout: $('#gfLayout').value,
    modFolder: $('#gfFolder').value,
    titleId: $('#gfTitleId').value,
  };
  if (!id) { $('#gfError').textContent = 'Game id must be a number.'; return; }
  if (!entry.modFolder) { $('#gfError').textContent = 'Pick a mod folder.'; return; }
  if (entry.layout === 'ryujinx' && !entry.titleId) { $('#gfError').textContent = 'Ryujinx layout needs a title id.'; return; }
  try {
    state.games = await window.electron.saveGame(id, entry);
    closeGameDialog();
    state.gameId = id;
    renderGameList();
    onGameChanged();
    if (state.detail) renderDetail(state.detail);   // Install buttons may have just become valid
    toast(`Saved ${entry.name}`, 'ok');
  } catch (err) {
    $('#gfError').textContent = 'Save failed: ' + (err.message || err);
  }
});
$('#gfDelete').addEventListener('click', async () => {
  if (!editingGameId) return;
  const g = state.games[editingGameId];
  if (!confirm(`Remove "${g.name}" from games.json? Installed mods on disk are not touched.`)) return;
  state.games = await window.electron.deleteGame(editingGameId);
  closeGameDialog();
  const ids = Object.keys(state.games);
  if (!ids.includes(state.gameId)) state.gameId = ids[0] || null;
  renderGameList();
  onGameChanged();
});

// ---------------------------------------------------------------- tabs, mod id input, add-mod push, keys

function setView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $('#view-browse').classList.toggle('hidden', view !== 'browse');
  $('#view-installed').classList.toggle('hidden', view !== 'installed');
  $('#browseControls').classList.toggle('hidden', view !== 'browse');
  if (view === 'installed') loadInstalled();
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));

function openFromInput() {
  const v = $('#modIdInput').value.trim();
  const m = v.match(/(\d+)/);
  if (!m) return;
  $('#modIdInput').value = '';
  openDetail(m[1]);
}
$('#openModBtn').addEventListener('click', openFromInput);
$('#modIdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') openFromInput(); });

// Pushed from the localhost:3000/add-mod/<id> endpoint.
window.api.receive('add-mod', (modId) => {
  openDetail(modId).then(() => {
    // Switch the sidebar to the mod's game when we know it.
    const mod = state.detail;
    const gid = mod && mod._aGame && mod._aGame._idRow != null ? String(mod._aGame._idRow) : null;
    if (gid && state.games[gid] && gid !== state.gameId) { state.gameId = gid; renderGameList(); onGameChanged(); }
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').classList.contains('hidden')) $('#lightbox').classList.add('hidden');
  else if (!$('#gameDialog').classList.contains('hidden')) closeGameDialog();
  else if (!$('#detailOverlay').classList.contains('hidden')) closeDetail();
});

// ---------------------------------------------------------------- boot

loadGames().catch(err => { $('#browseStatus').textContent = 'Startup failed: ' + (err.message || err); });
