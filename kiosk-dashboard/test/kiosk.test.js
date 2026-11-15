const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, password = 'test-password', mockAdb = false, overrides = null, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiosk-test-'));
  await fs.copyFile(path.join(__dirname, '..', 'server.js'), path.join(root, 'server.js'));
  await fs.cp(path.join(__dirname, '..', 'public'), path.join(root, 'public'), { recursive: true });
  if (overrides) {
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data', 'fixed-overrides.json'), JSON.stringify(overrides));
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const calls = path.join(root, 'adb-calls.jsonl');
  const preload = path.join(root, 'mock-adb.js');
  if (mockAdb) {
    await fs.writeFile(preload, `
      const fs = require('fs');
      require('child_process').execFile = (_bin, args, _options, callback) => {
        fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
        const offline = ${JSON.stringify(path.join(root, 'adb-offline-once'))};
        const connectFailure = ${JSON.stringify(path.join(root, 'adb-connect-failure'))};
        setTimeout(() => {
          if (args[0] === 'connect' && fs.existsSync(connectFailure)) {
            return callback(null, 'failed to connect to ' + args[1], '');
          }
          if (args[0] !== 'connect' && fs.existsSync(offline)) {
            fs.unlinkSync(offline);
            return callback(new Error('device offline'), '', 'error: device offline');
          }
          const output = args[0] === 'connect' ? 'connected to ' + args[1] :
            args.includes('size') ? (process.env.ADB_MOCK_SIZE || 'Physical size: 1920x1080') :
            args.includes('get-state') ? 'device' : 'OK';
          callback(null, output, '');
        }, 80);
      };
    `);
  }
  let child;
  async function start() {
    const args = mockAdb ? ['--require', preload, path.join(root, 'server.js')] : [path.join(root, 'server.js')];
    child = spawn(process.execPath, args, {
      env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules'), PORT: String(port), FIRESTICK_IP: mockAdb ? '127.0.0.1' : '', KIOSK_ADMIN_PASSWORD: password, ...env },
      stdio: 'ignore'
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Testserver beendet: ' + child.exitCode);
      try { await fetch(base + '/api/settings'); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    throw new Error('Testserver nicht erreichbar');
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  await start();
  return { base, root, calls, start, stop };
}

function request(base, route, { method = 'GET', body, cookie, headers = {} } = {}) {
  return fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
}

async function login(base) {
  const response = await request(base, '/api/login', { method: 'POST', body: { password: 'test-password' } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('fresh install protects management, and panels persist without exposing other defaults', async t => {
  const { base, start, stop } = await fixture(t);
  assert.deepEqual(await (await request(base, '/api/dashboards/fixed')).json(), []);
  assert.deepEqual(await (await request(base, '/api/dashboards/custom')).json(), []);
  assert.equal((await request(base, '/api/dashboards/fixed?includeHidden=true')).status, 401);
  assert.equal((await request(base, '/API/adb/launch', { method: 'POST', body: { url: 'https://example.com' } })).status, 401);
  assert.equal((await request(base, '/api/firetv-screen.png')).status, 401);
  assert.equal((await request(base, '/admin.html')).status, 302);
  assert.equal((await request(base, '/%61dmin.html')).status, 302);
  assert.equal((await request(base, '/api/dashboards/custom', { method: 'POST', body: { title: 'Test', route: 'https://example.com' } })).status, 401);
  assert.equal((await request(base, '/api/login', { method: 'POST', headers: { Origin: 'https://other.example' }, body: { password: 'test-password' } })).status, 403);
  assert.equal((await request(base, '/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const publicSettings = await (await request(base, '/api/settings')).json();
  assert.equal(publicSettings.adbPath, undefined);
  assert.equal(publicSettings.firestickIp, undefined);

  const cookie = await login(base);
  assert.equal((await request(base, '/admin.html', { cookie })).status, 200);
  assert.equal((await request(base, '/api/settings', { method: 'PUT', cookie, body: { firestickIp: '127.0.0.1;invalid' } })).status, 400);
  assert.equal((await request(base, '/api/dashboards/custom', { method: 'POST', cookie, body: { title: 'Bad', route: 'javascript:alert(1)' } })).status, 400);
  const created = await request(base, '/api/dashboards/custom', { method: 'POST', cookie, body: { title: '<b>Test</b>', route: 'https://example.com' } });
  assert.equal(created.status, 201);
  assert.equal((await request(base, '/data/custom-dashboards.json')).status, 404);
  assert.equal((await request(base, '/api/dashboards/fixed/brave', { method: 'PUT', cookie, body: { hidden: false } })).status, 200);
  assert.deepEqual((await (await request(base, '/api/dashboards/fixed')).json()).map(tile => tile.id), ['brave']);
  await stop();
  await start();
  assert.equal((await (await request(base, '/api/dashboards/custom')).json())[0].title, '<b>Test</b>');
  assert.deepEqual((await (await request(base, '/api/dashboards/fixed')).json()).map(tile => tile.id), ['brave']);
  assert.equal((await request(base, '/api/adb/launch', { method: 'POST', cookie, body: { url: 'https://example.com' } })).status, 401);
});

test('missing password locks administration', async t => {
  const { base } = await fixture(t, '');
  assert.equal((await request(base, '/api/login', { method: 'POST', body: { password: '' } })).status, 503);
});

test('existing fixed-panel overrides remain visible after upgrade', async t => {
  const { base } = await fixture(t, 'test-password', false, { grafana: { title: 'Mein Monitoring', route: 'https://example.com' } });
  const tiles = await (await request(base, '/api/dashboards/fixed')).json();
  assert.deepEqual(tiles.map(tile => tile.id), ['dart-dashboard', 'grafana', 'wm2026', 'brave']);
  assert.equal(tiles.find(tile => tile.id === 'grafana').title, 'Mein Monitoring');
});

test('APK download follows redirects before attempting ADB', async t => {
  const { base } = await fixture(t);
  let downloaded = false;
  const mock = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file.apk' }); res.end(); return; }
    downloaded = true;
    res.end('fake apk');
  });

  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const cookie = await login(base);
  const response = await request(base, '/api/adb/install', { method: 'POST', cookie, body: { apkPath: `http://127.0.0.1:${mock.address().port}/redirect` } });
  assert.equal(response.status, 500);
  assert.equal(downloaded, true);
  assert.doesNotMatch((await response.json()).error, /HTTP 302/);
});

test('ADB receives a quoted URL and concurrent screenshots do not overlap', async t => {
  const { base, calls } = await fixture(t, 'test-password', true);
  const cookie = await login(base);
  const url = "https://example.com/a'$(danger)";
  const launch = await request(base, '/api/adb/launch', { method: 'POST', cookie, body: { url } });
  assert.equal(launch.status, 200);
  const first = request(base, '/api/firetv-screenshot', { cookie });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await request(base, '/api/firetv-screenshot', { cookie })).status, 429);
  const screenshot = await first;
  assert.equal(screenshot.status, 200);
  const size = await screenshot.json();
  assert.equal(size.width, 1920);
  assert.equal(size.height, 1080);
  const recorded = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const launchArgs = recorded.find(args => args.includes('android.intent.action.VIEW'));
  assert.equal(launchArgs[launchArgs.indexOf('-d') + 1], "'https://example.com/a'\\''$(danger)'");
  assert.equal(recorded.filter(args => args.includes('screencap')).length, 1);
});

test('ADB connects to changed address, tests status without launching, and reconnects when offline', async t => {
  const { base, root, calls } = await fixture(t, 'test-password', true, null, { FIRESTICK_IP: '' });
  const cookie = await login(base);
  assert.equal((await request(base, '/api/adb/status')).status, 401);
  assert.equal((await request(base, '/api/settings', { method: 'PUT', cookie, body: { firestickIp: '192.0.2.10' } })).status, 200);
  assert.equal((await request(base, '/api/adb/status', { cookie })).status, 200);
  let recorded = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recorded, [['connect', '192.0.2.10:5555'], ['-s', '192.0.2.10:5555', 'get-state']]);

  await fs.writeFile(path.join(root, 'adb-offline-once'), '');
  assert.equal((await request(base, '/api/adb/status', { cookie })).status, 200);
  recorded = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recorded.slice(2), [
    ['-s', '192.0.2.10:5555', 'get-state'],
    ['connect', '192.0.2.10:5555'],
    ['-s', '192.0.2.10:5555', 'get-state']
  ]);
  assert.equal((await request(base, '/api/settings', { method: 'PUT', cookie, body: { firestickIp: '192.0.2.20' } })).status, 200);
  assert.equal((await request(base, '/api/adb/status', { cookie })).status, 200);
  recorded = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recorded.slice(-2), [['connect', '192.0.2.20:5555'], ['-s', '192.0.2.20:5555', 'get-state']]);

  await request(base, '/api/settings', { method: 'PUT', cookie, body: { firestickIp: '192.0.2.30' } });
  await fs.writeFile(path.join(root, 'adb-connect-failure'), '');
  const failure = await request(base, '/api/adb/status', { cookie });
  assert.equal(failure.status, 500);
  assert.match((await failure.json()).error, /failed to connect/);
  await fs.unlink(path.join(root, 'adb-connect-failure'));
  assert.equal((await request(base, '/api/adb/status', { cookie })).status, 200);
});

test('screenshot uses override resolution when available', async t => {
  const { base } = await fixture(t, 'test-password', true, null, {
    ADB_MOCK_SIZE: 'Physical size: 1920x1080\nOverride size: 1280x720'
  });
  const cookie = await login(base);
  const response = await request(base, '/api/firetv-screenshot', { cookie });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
});

test('environment settings remain defaults until explicitly saved', async t => {
  const env = { FIRESTICK_IP: '192.0.2.10' };
  const { base, root, stop, start } = await fixture(t, 'test-password', true, null, env);
  let cookie = await login(base);
  assert.equal((await (await request(base, '/api/settings', { cookie })).json()).firestickIp, '192.0.2.10');
  await request(base, '/api/settings', { method: 'PUT', cookie, body: { hubTitle: 'Test' } });
  const saved = JSON.parse(await fs.readFile(path.join(root, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.firestickIp, undefined);
  await stop();
  env.FIRESTICK_IP = '192.0.2.11';
  await start();
  cookie = await login(base);
  assert.equal((await (await request(base, '/api/settings', { cookie })).json()).firestickIp, '192.0.2.11');
  const updated = await request(base, '/api/settings', { method: 'PUT', cookie, body: { firestickIp: '192.0.2.20' } });
  assert.equal((await updated.json()).firestickIp, '192.0.2.20');
  await stop();
  env.FIRESTICK_IP = '192.0.2.12';
  await start();
  cookie = await login(base);
  assert.equal((await (await request(base, '/api/settings', { cookie })).json()).firestickIp, '192.0.2.20');
});
