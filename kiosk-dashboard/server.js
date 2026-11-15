const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

// SSE-Clients – alle offenen Dashboards sofort benachrichtigen
const sseClients = new Set();
function broadcastReload() {
  sseClients.forEach(res => { try { res.write('event: reload\ndata: 1\n\n'); } catch { sseClients.delete(res); } });
}

function getLocalIP() {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal && !alias.address.startsWith('169.254.'))
        return alias.address;
    }
  }
  return 'localhost';
}

const app = express();
if (process.env.KIOSK_TRUST_PROXY) app.set('trust proxy', process.env.KIOSK_TRUST_PROXY);
const PORT = process.env.PORT || 3000;
const PUBLIC_PORT = process.env.PUBLIC_PORT || PORT;
const FIRE_FEATURES_ENABLED = String(process.env.FIRE_FEATURES_ENABLED || 'true').toLowerCase() === 'true';
const ADMIN_PASSWORD = process.env.KIOSK_ADMIN_PASSWORD || '';
const DART_DASHBOARD_PORT = process.env.DART_DASHBOARD_PORT || '3000';
const DART_DASHBOARD_URL = process.env.DART_DASHBOARD_URL || `http://${process.env.SERVER_IP || getLocalIP()}:${DART_DASHBOARD_PORT}`;

const DATA_DIR       = path.join(__dirname, 'data');
const CUSTOM_FILE    = path.join(DATA_DIR, 'custom-dashboards.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'fixed-overrides.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PLAYERS_FILE   = path.join(DATA_DIR, 'players.json');
const BRAVE_URLS_FILE  = path.join(DATA_DIR, 'brave-urls.json');
const BRAVE_MEDIA_FILE = path.join(DATA_DIR, 'brave-media.json');

const DEFAULT_MEDIA = [
  { id: 'm-yt',   title: 'YouTube',     icon: '▶️',  url: 'https://www.youtube.com',   color: '#FF0000' },
  { id: 'm-nf',   title: 'Netflix',     icon: '🎬', url: 'https://www.netflix.com',    color: '#E50914' },
  { id: 'm-tw',   title: 'Twitch',      icon: '🎮', url: 'https://www.twitch.tv',      color: '#00A8E1' },
  { id: 'm-pv',   title: 'Prime Video', icon: '📺', url: 'https://www.primevideo.com', color: '#FF9900' },
  { id: 'm-sp',   title: 'Spotify',     icon: '🎵', url: 'https://open.spotify.com',   color: '#1DB954' },
  { id: 'm-dazn', title: 'DAZN',        icon: '⚽', url: 'https://www.dazn.com',       color: '#FFFC00' },
];

const ADB_DEFAULT = process.env.ADB_PATH || (
  process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Touch Portal\\plugins\\adb\\platform-tools\\adb.exe'
    : 'adb'
);
const BRAVE_PKG   = 'com.brave.browser';

app.use(express.json({ limit: '32kb' }));

const sessions = new Map();
const loginAttempts = new Map();
const sessionLifetime = 12 * 60 * 60 * 1000;
const sessionCookie = 'kiosk_session';

function isAuthenticated(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(sessionCookie + '='));
  const token = cookie ? cookie.slice(sessionCookie.length + 1) : '';
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('Origin');
    if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      return res.status(403).json({ error: 'Ungueltige Anfragequelle' });
    }
  }
  next();
});

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'KIOSK_ADMIN_PASSWORD ist nicht konfiguriert.' });
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(ip);
  const attempt = loginAttempts.get(req.ip);
  if (attempt && attempt.count >= 10) return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte spaeter erneut versuchen.' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const actual = crypto.createHash('sha256').update(password).digest();
  const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(actual, expected)) {
    loginAttempts.set(req.ip, { count: (attempt?.count || 0) + 1, until: attempt?.until || now + 15 * 60 * 1000 });
    return res.status(401).json({ error: 'Passwort falsch.' });
  }
  loginAttempts.delete(req.ip);
  for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now + sessionLifetime);
  res.cookie(sessionCookie, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: sessionLifetime, path: '/' });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(sessionCookie + '='));
  if (cookie) sessions.delete(cookie.slice(sessionCookie.length + 1));
  res.clearCookie(sessionCookie, { path: '/' });
  res.json({ ok: true });
});

app.use((req, res, next) => {
  let page;
  try { page = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, '/').toLowerCase()); }
  catch { return res.status(400).send('Ungueltiger Pfad'); }
  const publicApi = req.method === 'GET' && ['/api/dashboards/fixed', '/api/dashboards/custom', '/api/settings', '/api/events'].includes(page);
  if ((page === '/api' || page.startsWith('/api/')) && !publicApi && !isAuthenticated(req)) {
    return res.status(401).json({ error: 'Admin-Anmeldung erforderlich.' });
  }
  if (['/admin.html', '/panels/brave.html', '/panels/spieler.html'].includes(page) && !isAuthenticated(req)) {
    return res.redirect('/login.html?next=' + encodeURIComponent(page));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

const fixedDefaults = [
  { id: 'dart-dashboard', title: 'Dart Dashboard',  icon: '🎯', description: 'Haupt-Dashboard fuer Dart und Statistiken',      color: '#e63946', route: DART_DASHBOARD_URL,                         external: true,  badge: 'Extern'     },
  { id: 'grafana',        title: 'Grafana',         icon: '📊', description: 'Metriken, Graphen & Monitoring',                color: '#f46800', route: 'http://localhost:3001',                   external: true,  badge: 'Monitoring' },
  { id: 'wm2026',         title: 'WM 2026',         icon: '🌍', description: 'FIFA Weltmeisterschaft 2026 – Spielplan',      color: '#2a9d8f', route: '/panels/wm2026/index.html',               external: false, badge: 'Lokal'      },
  { id: 'brave',          title: 'Browser',         icon: '\uD83E\uDD81', description: 'YouTube & Web-Inhalte ueber Brave Browser', color: '#FB542B', route: '/panels/brave.html',               external: false, badge: 'Brave'      }
];

function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { console.error('[Daten] Lesen fehlgeschlagen:', file, error.message); }
  return fallback;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getFixed(includeHidden = false) {
  const ov = readJson(OVERRIDES_FILE, {});
  const existing = fs.existsSync(OVERRIDES_FILE);
  const list = fixedDefaults.map(d => ({ ...d, hidden: !existing, ...(ov[d.id] || {}) }));
  return includeHidden ? list : list.filter(d => !d.hidden);
}
function getCustom()   { return readJson(CUSTOM_FILE, []); }
function saveCustom(l) { writeJson(CUSTOM_FILE, l); }
function getSettings() {
  const settings = {
    hubTitle: 'Löwen Dart – Kiosk Hub',
    autoReloadMinutes: 5,
    screensaverEnabled: true,
    screensaverMinutes: 2,
    remoteKeymap: {
      hub: {
        back: 'close_modal_or_back',
        menu: 'open_admin',
        playpause: 'reload_hub'
      },
      admin: {
        back: 'close_modal_or_hub',
        menu: 'open_quick_actions',
        playpause: 'refresh_admin'
      }
    },
    fireFeaturesEnabled: FIRE_FEATURES_ENABLED,
    adbPath: process.env.ADB_PATH || ADB_DEFAULT,
    firestickIp: process.env.FIRESTICK_IP || '',
    ...readJson(SETTINGS_FILE, {})
  };
  if (process.platform !== 'win32' && /^[a-z]:\\/i.test(settings.adbPath)) settings.adbPath = ADB_DEFAULT;
  return settings;
}
function saveSettings(s){ writeJson(SETTINGS_FILE, s); }

function getPlayers() {
  const defaults = Array.from({ length: 8 }, (_, i) => ({ slot: i + 1, name: '', active: false }));
  const saved = readJson(PLAYERS_FILE, []);
  return defaults.map(d => { const s = saved.find(p => p.slot === d.slot); return s ? { ...d, ...s } : d; });
}
function savePlayers(list) { writeJson(PLAYERS_FILE, list); }

function validPanelFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  if (Object.keys(fields).some(key => !['title', 'icon', 'description', 'badge', 'color', 'route', 'external', 'hidden'].includes(key))) return false;
  for (const key of ['title', 'icon', 'description', 'badge']) {
    if (fields[key] !== undefined && (typeof fields[key] !== 'string' || fields[key].length > 500)) return false;
  }
  if (fields.color !== undefined && (typeof fields.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(fields.color))) return false;
  if (fields.route !== undefined && (typeof fields.route !== 'string' ||
      !(validHttpUrl(fields.route) || (/^\/(?!\/)/.test(fields.route) && !/[\u0000-\u0020\\]/.test(fields.route))))) return false;
  for (const key of ['external', 'hidden']) if (fields[key] !== undefined && typeof fields[key] !== 'boolean') return false;
  return true;
}

// ── Fixed tiles ──
app.get('/api/dashboards/fixed', (req, res) => {
  const includeHidden = String(req.query.includeHidden || 'false').toLowerCase() === 'true';
  if (includeHidden && !isAuthenticated(req)) return res.status(401).json({ error: 'Admin-Anmeldung erforderlich.' });
  res.json(getFixed(includeHidden));
});
app.put('/api/dashboards/fixed/:id', (req, res) => {
  const def = fixedDefaults.find(d => d.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!validPanelFields(req.body)) return res.status(400).json({ error: 'Ungueltige Kacheldaten' });
  const ov = fs.existsSync(OVERRIDES_FILE)
    ? readJson(OVERRIDES_FILE, {})
    : Object.fromEntries(fixedDefaults.map(tile => [tile.id, { hidden: true }]));
  ov[req.params.id] = { ...(ov[req.params.id] || {}), ...req.body };
  writeJson(OVERRIDES_FILE, ov);
  broadcastReload();
  res.json({ ...def, ...ov[req.params.id] });
});

// ── Custom tiles ──
app.get('/api/dashboards/custom', (req, res) => res.json(getCustom()));
app.post('/api/dashboards/custom', (req, res) => {
  const { title, icon, description, color, route, external, badge } = req.body || {};
  if (!title || !route || !validPanelFields(req.body)) return res.status(400).json({ error: 'Ungueltige Kacheldaten' });
  const list = getCustom();
  const entry = { id: 'custom-' + Date.now(), title, icon: icon || '🔗', description: description || '', color: color || '#6c757d', route, external: !!external, badge: badge || 'Custom' };
  list.push(entry);
  saveCustom(list);
  broadcastReload();
  res.status(201).json(entry);
});
app.put('/api/dashboards/custom/:id', (req, res) => {
  if (!validPanelFields(req.body)) return res.status(400).json({ error: 'Ungueltige Kacheldaten' });
  const list = getCustom();
  const i = list.findIndex(d => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  list[i] = { ...list[i], ...req.body, id: list[i].id };
  saveCustom(list);
  broadcastReload();
  res.json(list[i]);
});
app.delete('/api/dashboards/custom/:id', (req, res) => {
  let list = getCustom();
  const before = list.length;
  list = list.filter(d => d.id !== req.params.id);
  if (list.length === before) return res.status(404).json({ error: 'Nicht gefunden' });
  saveCustom(list);
  broadcastReload();
  res.json({ ok: true });
});

// ── Players ──
app.get('/api/players', (req, res) => res.json(getPlayers()));
app.put('/api/players', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array erwartet' });
  savePlayers(req.body);
  broadcastReload();
  res.json({ ok: true });
});

// ── Server-Info ──
app.get('/api/server-info', (req, res) => {
  const s = getSettings();
  const detectedIp = getLocalIP();
  const ip = s.serverIp || detectedIp;
  res.json({ ip, detectedIp, port: PORT, kioskUrl: `http://${ip}:${PORT}` });
});

// ── Settings ──
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  if (isAuthenticated(req)) return res.json(settings);
  const { hubTitle, autoReloadMinutes, screensaverEnabled, screensaverMinutes, remoteKeymap } = settings;
  res.json({ hubTitle, autoReloadMinutes, screensaverEnabled, screensaverMinutes, remoteKeymap });
});
app.put('/api/settings', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      (req.body.adbPath !== undefined && typeof req.body.adbPath !== 'string') ||
      (req.body.firestickIp !== undefined && (typeof req.body.firestickIp !== 'string' || (req.body.firestickIp && !/^[a-z0-9._-]+$/i.test(req.body.firestickIp)))) ||
      (req.body.serverIp !== undefined && (typeof req.body.serverIp !== 'string' || (req.body.serverIp && !/^[a-z0-9._-]+$/i.test(req.body.serverIp))))) {
    return res.status(400).json({ error: 'Ungueltige Einstellungen' });
  }
  const s = { ...readJson(SETTINGS_FILE, {}), ...req.body };
  saveSettings(s);
  broadcastReload();
  res.json(getSettings());
});

// SSE – Live-Push an alle offenen Dashboard-Browser
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  // Keepalive alle 25s (verhindert Timeout bei Proxys/Firewalls)
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { clearInterval(ka); sseClients.delete(res); } }, 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

// ── ADB / Brave ──
function getBraveUrls()   { return readJson(BRAVE_URLS_FILE, []); }
function saveBraveUrls(l) { writeJson(BRAVE_URLS_FILE, l); }
function getMediaTiles()  { return fs.existsSync(BRAVE_MEDIA_FILE) ? readJson(BRAVE_MEDIA_FILE, DEFAULT_MEDIA) : DEFAULT_MEDIA; }
function saveMediaTiles(l){ writeJson(BRAVE_MEDIA_FILE, l); }

app.post('/api/adb/launch', (req, res) => {
  const { url } = req.body || {};
  if (!validHttpUrl(url))
    return res.status(400).json({ error: 'Ungültige URL' });
  runAdb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellQuote(url), BRAVE_PKG], (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
    if (/(^|\n)\s*(Error|Exception):/i.test(stdout)) return res.status(500).json({ error: stdout.trim() });
    res.json({ ok: true, output: stdout.trim() });
  });
});

function validHttpUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function shellQuote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
let adbConnection = null;
function connectAdb(settings) {
  const device = String(settings.firestickIp || '');
  if (!/^[a-z0-9._-]+$/i.test(device)) return Promise.reject(new Error('Ungueltige Fire-Stick-Adresse'));
  const adbPath = settings.adbPath || ADB_DEFAULT;
  const target = device + ':5555';
  const key = JSON.stringify([adbPath, target]);
  if (adbConnection && adbConnection.key === key) return adbConnection.promise;
  const connection = { key };
  connection.promise = new Promise((resolve, reject) => {
    execFile(adbPath, ['connect', target], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      if (!/^(?:already connected to|connected to)\s/m.test(stdout || '')) {
        return reject(new Error((stdout || stderr || 'ADB-Verbindung fehlgeschlagen').trim()));
      }
      resolve();
    });
  }).catch(error => {
    if (adbConnection === connection) adbConnection = null;
    throw error;
  });
  adbConnection = connection;
  return connection.promise;
}
function runAdb(args, callback, timeout = 15000) {
  const settings = getSettings();
  const target = String(settings.firestickIp || '') + ':5555';
  const key = JSON.stringify([settings.adbPath || ADB_DEFAULT, target]);
  function run(retry) {
    connectAdb(settings).then(() => {
      execFile(settings.adbPath || ADB_DEFAULT, ['-s', target, ...args], { timeout }, (err, stdout, stderr) => {
        if (err && adbConnection && adbConnection.key === key) adbConnection = null;
        if (err && retry && /(?:error:\s*)?device(?:\s+['"][^'"]+['"])?\s+(?:offline|not found)\b/i.test(stderr || err.message)) {
          return run(false);
        }
        callback(err, stdout, stderr);
      });
    }, error => callback(error, '', ''));
  }
  run(true);
}

app.get('/api/adb/status', (_req, res) => {
  runAdb(['get-state'], (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
    if (stdout.trim() !== 'device') return res.status(500).json({ error: 'Fire Stick nicht bereit: ' + stdout.trim() });
    res.json({ ok: true });
  });
});

app.post('/api/adb/install', async (req, res) => {
  const { apkPath } = req.body || {};
  if (typeof apkPath !== 'string' || !apkPath) return res.status(400).json({ error: 'URL oder Pfad fehlt' });
  let localPath = apkPath;
  let tempFile = '';
  try {
    if (/^https?:\/\//i.test(apkPath)) {
      if (!validHttpUrl(apkPath)) return res.status(400).json({ error: 'Ungueltige Download-URL' });
      const response = await fetch(apkPath, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error('Download fehlgeschlagen: HTTP ' + response.status);
      tempFile = path.join(os.tmpdir(), 'apk-install-' + crypto.randomBytes(16).toString('hex') + '.apk');
      let total = 0;
      const limit = 200 * 1024 * 1024;
      const counter = new Transform({ transform(chunk, _encoding, callback) {
        total += chunk.length;
        callback(total > limit ? new Error('APK ist groesser als 200 MB') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(tempFile, { flags: 'wx' }));
      localPath = tempFile;
    } else if (!apkPath.toLowerCase().endsWith('.apk')) {
      return res.status(400).json({ error: 'Kein gültiger APK-Pfad' });
    }
    await new Promise((resolve, reject) => runAdb(['install', '-r', localPath], (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      if (!/(^|\n)\s*Success\s*($|\n)/i.test(stdout)) return reject(new Error((stdout || stderr || 'ADB meldet keine erfolgreiche Installation').trim()));
      resolve(stdout);
    }, 120000));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (tempFile) fs.promises.unlink(tempFile).catch(error => {
      if (error.code !== 'ENOENT') console.error('[APK] Temporaere Datei konnte nicht entfernt werden:', error.message);
    });
  }
});

app.get('/api/brave-urls', (_req, res) => res.json(getBraveUrls()));
app.post('/api/brave-urls', (req, res) => {
  const { title, url, icon } = req.body || {};
  if (typeof title !== 'string' || !title || title.length > 500 || !validHttpUrl(url) || (icon !== undefined && typeof icon !== 'string'))
    return res.status(400).json({ error: 'title und gültige url erforderlich' });
  const list = getBraveUrls();
  const entry = { id: 'b-' + Date.now(), title, url, icon: icon || '🌐' };
  list.push(entry);
  saveBraveUrls(list);
  res.status(201).json(entry);
});
app.delete('/api/brave-urls/:id', (req, res) => {
  const list = getBraveUrls().filter(e => e.id !== req.params.id);
  saveBraveUrls(list);
  res.json({ ok: true });
});

app.get('/api/brave-media', (_req, res) => res.json(getMediaTiles()));
app.post('/api/brave-media', (req, res) => {
  const { title, url, icon, color } = req.body || {};
  if (typeof title !== 'string' || !title || title.length > 500 || !validHttpUrl(url) ||
      (icon !== undefined && typeof icon !== 'string') || (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)))
    return res.status(400).json({ error: 'title und gültige url erforderlich' });
  const list = getMediaTiles();
  const entry = { id: 'm-' + Date.now(), title, url, icon: icon || '🌐', color: color || '#555555' };
  list.push(entry);
  saveMediaTiles(list);
  res.status(201).json(entry);
});
app.delete('/api/brave-media/:id', (req, res) => {
  const list = getMediaTiles().filter(e => e.id !== req.params.id);
  saveMediaTiles(list);
  res.json({ ok: true });
});

app.post('/api/restart', (_req, res) => {
  res.json({ ok: true, message: 'Server wird neu gestartet...' });
  setTimeout(() => process.exit(0), 400);
});

// Brave als Standard-Browser setzen (ohne Interaktion am Fire TV)
app.post('/api/set-default-browser', (_req, res) => {
  runAdb(['shell', 'cmd', 'package', 'set-default-browser', BRAVE_PKG], (err, stdout) => {
    if (err) {
      runAdb(['shell', 'pm', 'set-preferred-activity', '--action', 'android.intent.action.VIEW', '--category', 'android.intent.category.DEFAULT', '--category', 'android.intent.category.BROWSABLE', '--scheme', 'http', BRAVE_PKG + '/.app.BraveActivity'], (err2, out2) => {
        res.json({ ok: !err2, stdout: out2, error: err2 ? err2.message : null });
      });
    } else {
      res.json({ ok: true, stdout });
    }
  });
});

// ADB-Tasteneingabe senden (z. B. um Dialoge am Fire TV zu bestätigen)
app.post('/api/adb-key', (req, res) => {
  const { keycode } = req.body || {};
  if (!keycode || !/^\d+$/.test(String(keycode))) {
    return res.status(400).json({ ok: false, error: 'Ungültiger Keycode' });
  }
  runAdb(['shell', 'input', 'keyevent', String(keycode)], (err, stdout) => {
    res.json({ ok: !err, stdout, error: err ? err.message : null });
  });
});

// Bildschirm-Tap per ADB (für Dialog-Buttons die mit Fernbedienung nicht erreichbar sind)
app.post('/api/adb-tap', (req, res) => {
  const { x, y } = req.body || {};
  const xi = parseInt(x, 10);
  const yi = parseInt(y, 10);
  if (isNaN(xi) || isNaN(yi) || xi < 0 || yi < 0 || xi > 3840 || yi > 2160) {
    return res.status(400).json({ ok: false, error: 'Ungültige Koordinaten' });
  }
  runAdb(['shell', 'input', 'tap', String(xi), String(yi)], (err, stdout) => {
    res.json({ ok: !err, stdout, error: err ? err.message : null });
  });
});

app.post('/api/adb-text', (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.length > 200) {
    return res.status(400).json({ ok: false, error: 'Ungültiger Text' });
  }
  const androidText = text.replace(/ /g, '%s');
  runAdb(['shell', 'input', 'text', shellQuote(androidText)], (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

// Screenshot vom Fire TV aufnehmen und als PNG zurückgeben
let screenshotInProgress = false;
app.get('/api/firetv-screenshot', (req, res) => {
  if (screenshotInProgress) return res.status(429).json({ ok: false, error: 'Screenshot bereits in Arbeit' });
  screenshotInProgress = true;
  const tmpFile = path.join(DATA_DIR, 'firetv-screen.png');
  const fail = err => { screenshotInProgress = false; res.status(500).json({ ok: false, error: err.message }); };
  runAdb(['shell', 'screencap', '-p', '/sdcard/_dash_screen.png'], (err) => {
    if (err) return fail(err);
    runAdb(['pull', '/sdcard/_dash_screen.png', tmpFile], (err2) => {
      if (err2) return fail(err2);
      runAdb(['shell', 'wm', 'size'], (err3, sizeOut) => {
        screenshotInProgress = false;
        if (err3) return res.status(500).json({ ok: false, error: err3.message });
        const output = sizeOut || '';
        const match = output.match(/Override size:\s*(\d+)x(\d+)/i) ||
          output.match(/Physical size:\s*(\d+)x(\d+)/i) || output.match(/(\d+)x(\d+)/);
        if (!match) return res.status(500).json({ ok: false, error: 'Bildschirmaufloesung nicht ermittelbar' });
        const w = parseInt(match[1], 10);
        const h = parseInt(match[2], 10);
        res.json({ ok: true, width: w, height: h, ts: Date.now() });
      });
    });
  });
});

// Fully Kiosk beenden + TV Launcher starten (damit Fernbedienung wieder funktioniert)
app.post('/api/fully-stop', (_req, res) => {
  runAdb(['shell', 'am', 'force-stop', 'de.ozerov.fully'], (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    runAdb(['shell', 'am', 'start', '-n', 'com.amazon.tv.launcher/.ui.MainActivity'], (err2) => {
      res.json({ ok: !err2, error: err2 ? err2.message : null });
    });
  });
});

// Fully Kiosk starten
app.post('/api/fully-start', (_req, res) => {
  runAdb(['shell', 'am', 'start', '-n', 'de.ozerov.fully/.MainActivity'], (err) => {
    res.json({ ok: !err, error: err ? err.message : null });
  });
});

// Gespeichertes Screenshot-Bild ausliefern
app.get('/api/firetv-screen.png', (req, res) => {
  const f = path.join(DATA_DIR, 'firetv-screen.png');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

app.listen(PORT, () => {
  console.log('Dashboard: http://localhost:' + PORT);
  console.log('Admin:     http://localhost:' + PORT + '/admin.html');
  if (!ADMIN_PASSWORD) console.warn('[Admin] KIOSK_ADMIN_PASSWORD fehlt; Verwaltung ist gesperrt.');
  autoLaunchKiosk();
});

function autoLaunchKiosk() {
  const s = getSettings();
  const dashUrl = `http://${s.serverIp || getLocalIP()}:${PUBLIC_PORT}`;
  if (!/^[a-z0-9._-]+$/i.test(String(s.firestickIp || ''))) {
    console.log('[Kiosk] Fire-Stick-Adresse nicht konfiguriert oder ungueltig.');
    return;
  }
  runAdb(['shell', 'am', 'start', '-n', 'de.ozerov.fully/.MainActivity', '-d', shellQuote(dashUrl)], (err) => {
    if (err) console.log('[Kiosk] Fully Kiosk Start fehlgeschlagen:', err.message);
    else console.log('[Kiosk] Fully Kiosk gestartet → ' + dashUrl);
  });
}

// Kiosk-URL manuell neu setzen (nützlich nach Port-Änderungen)
app.post('/api/kiosk-reload', (_req, res) => {
  const s = getSettings();
  const dashUrl = `http://${s.serverIp || getLocalIP()}:${PUBLIC_PORT}`;
  runAdb(['shell', 'am', 'start', '-n', 'de.ozerov.fully/.MainActivity', '-d', shellQuote(dashUrl)], (err) => {
    res.json({ ok: !err, url: dashUrl, error: err ? err.message : null });
  });
});
