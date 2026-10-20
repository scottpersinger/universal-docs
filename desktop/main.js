// The desktop app (Electron). It opens a folder as the library: the folder given on the command line, or
// the directory the app was started in. The app itself is the web app, served to this window by a local
// server (desktop/server.ts) that reads and writes the folder's files.
import { app, BrowserWindow, clipboard, dialog, Menu, session, shell } from 'electron';
import { execFile, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { contextMenuTemplate } from './contextMenu.js';
import { LocalOAuth } from './mcpAuth.js';

const root = path.resolve(import.meta.dirname, '..');
// Also names the app's data directory, which would otherwise be the generic "Electron" one.
// The name the app's data folder is kept under (last folder, each folder's database): changing it would lose them.
app.setName('MCP Docs');
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// The app was called Universal Docs, and before that FreeFlow Docs: the first time it starts under its new name,
// its data folder moves over.
const legacyData = ['Universal Docs', 'FreeFlow Docs'].map((name) => path.join(app.getPath('appData'), name)).find(isDir);
if (!existsSync(app.getPath('userData')) && legacyData) {
  try {
    renameSync(legacyData, app.getPath('userData'));
  } catch (e) {
    console.error(`Could not move ${legacyData}: ${e.message}`);
  }
}

// The installed app is started from a menu or an icon, where the current directory means nothing: it
// reopens the folder it showed last, or the home folder the first time.
const lastFolderFile = () => path.join(app.getPath('userData'), 'last-folder.txt');
function lastFolder() {
  try {
    const dir = readFileSync(lastFolderFile(), 'utf8').trim();
    return dir && isDir(dir) ? dir : null;
  } catch {
    return null;
  }
}
function rememberFolder(dir) {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(lastFolderFile(), dir);
  } catch {
    // Not remembered, that's all.
  }
}

// --- Folders, their servers and the windows showing them ---------------------------------------------------
// Each window (a tab, on macOS) shows one folder, and each folder open in a window has a server of its own, which
// stops when its last window closes. Opening a folder changes the window it was asked in, not the others.
/** The servers running, by folder. */
const servers = new Map();
/** Folders whose server is starting, so two windows opening one folder share it. */
const starting = new Map();
/** Each window's server, by window id. */
const windowServers = new Map();
/** The window last in front: what the menu, Finder and agents act on. */
let front = null;

const serverOf = (win) => (win && !win.isDestroyed() ? windowServers.get(win.id) : undefined);
/** The server of the window in front; agents' MCP requests go to it. */
const frontServer = () => serverOf(BrowserWindow.getFocusedWindow()) ?? serverOf(front) ?? servers.values().next().value ?? null;

/** The window to show something of `server` in: the one in front when it is that server's, else one of its own. */
function windowFor(server) {
  const focused = BrowserWindow.getFocusedWindow();
  if (serverOf(focused) === server) return focused;
  if (serverOf(front) === server) return front;
  return [...server.windows][0] ?? null;
}

/** Make `win` one of `server`'s windows (and no longer one of the server it showed before). */
function attach(win, server) {
  const old = serverOf(win);
  if (old === server) return;
  windowServers.set(win.id, server);
  server.windows.add(win);
  if (old) {
    old.windows.delete(win);
    release(old);
  }
}

/** A window closed: its server stops if no window shows its folder any more. */
function detach(id, win) {
  const server = windowServers.get(id);
  windowServers.delete(id);
  if (front === win) front = null;
  if (!server) return;
  server.windows.delete(win);
  release(server);
}

function release(server) {
  if (server.windows.size) return;
  servers.delete(server.dir);
  server.child.removeAllListeners('exit');
  server.child.kill('SIGTERM');
  void session.defaultSession.cookies.remove(server.origin, server.cookie).catch(() => {});
}

function stopServers() {
  for (const server of servers.values()) {
    server.child.removeAllListeners('exit');
    server.child.kill('SIGTERM');
  }
  servers.clear();
}

// --- The MCP server, for agents on this machine (server/localMcp.ts) ------------------------------------
// The folder's server is on a port the system picks, and a new one starts with each folder. Agents are set up
// once, so they reach it on a fixed port, here, which passes MCP requests on to whichever server is running.
// An agent signs in with OAuth (mcpAuth.js): the person allows it in a dialog of the app, and it gets a token
// of its own. Requests it makes with that token are passed on with a secret the folder's server knows, made
// for each run of the app, which no agent ever sees.
const MCP_PORT = Number(process.env.UNIVERSAL_MCP_PORT) || 39217;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const MCP_SECRET = randomBytes(32).toString('base64url');
/** False until the port is ours: another copy of the app may hold it. */
let mcpListening = false;
let mcpAuth = null;

/** Ask the person whether an agent may connect, in front of whatever they are doing. */
async function approveAgent(name) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  bringToFront();
  const options = {
    type: 'question',
    title: 'Connect an Agent',
    message: `Allow “${name}” to use MCP Docs?`,
    detail:
      'It will be able to read, change, create and delete the files in the folders you open in the app, and show them in this window, until you disconnect it (File › Connect an Agent).\n\nAllow it only if you just asked an agent on this computer to connect. The name is the one the agent gave itself.',
    buttons: ['Allow', 'Don’t Allow'],
    defaultId: 0,
    cancelId: 1,
  };
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return res.response === 0;
}

/** What a request may be addressed to: this port on this computer, not a name a web page made point here. */
const ownHost = (host) => host === `127.0.0.1:${MCP_PORT}` || host === `localhost:${MCP_PORT}`;

function startMcpProxy() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  // The one shared token an earlier version kept: agents sign in now, so it opens nothing and goes.
  rmSync(path.join(app.getPath('userData'), 'mcp-token'), { force: true });
  mcpAuth = new LocalOAuth({ file: path.join(app.getPath('userData'), 'mcp-auth.json'), issuer: MCP_URL, approve: approveAgent });
  const proxy = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (!ownHost(req.headers.host)) return void res.writeHead(421).end();
    if (mcpAuth.handles(pathname)) {
      mcpAuth.handle(req, res).catch(() => !res.headersSent && res.writeHead(500).end());
      return;
    }
    // Only the MCP endpoint and the plugin's upload and file links; the app itself is not served here.
    const mcp = pathname === '/mcp' || pathname.startsWith('/mcp/');
    if (!(mcp || pathname.startsWith('/plugin/'))) return void res.writeHead(404).end();
    const headers = { ...req.headers };
    if (mcp) {
      if (!mcpAuth.verify(req.headers.authorization)) {
        // The agent learns where to sign in from this (RFC 9728), and opens the sign-in page.
        return void res
          .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${mcpAuth.resourceMetadataUrl}"` })
          .end(JSON.stringify({ error: 'unauthorized', error_description: 'Sign in: the app asks you to allow this agent.' }));
      }
      headers.authorization = `Bearer ${MCP_SECRET}`;
    }
    const current = frontServer();
    if (!current) return void res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The app is opening a folder. Try again in a moment.' }));
    const up = http.request({ host: '127.0.0.1', port: current.port, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The app’s server is not answering.' }));
      else res.end();
    });
    req.pipe(up);
  });
  proxy.on('error', (e) => {
    mcpListening = false;
    console.error(`MCP server not started on ${MCP_URL}: ${e.message}`);
  });
  proxy.listen(MCP_PORT, '127.0.0.1', () => {
    mcpListening = true;
  });
}

/**
 * Make the app the one in front. macOS (14 and later) no longer lets an app take the front on its own
 * (app.focus's steal is ignored), but it does when asked to open the app: for one already running, Launch
 * Services brings it forward rather than starting another.
 */
function bringToFront() {
  if (process.platform !== 'darwin') return app.focus();
  // .../MCP Docs.app/Contents/MacOS/MCP Docs (or Electron.app in development).
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) return app.focus({ steal: true });
  execFile('open', ['-a', bundle], (e) => e && app.focus({ steal: true }));
}

/**
 * Put a page of the app (a file the model opened, created or imported) in a window of `server`'s folder, and
 * bring the app to the front so the person sees it. Edits to the file already showing do not come here.
 */
function showPage(page, server = frontServer()) {
  if (!server) return;
  const win = windowFor(server);
  if (!win) return createWindow(server, `${server.origin}${page}`);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  bringToFront();
  // The client's router goes there (main.tsx), as a link in the app would.
  void win.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('universal-show', { detail: ${JSON.stringify(page)} }))`).catch(() => {});
}

/** An agent rewrote a stored file: a window showing it loads it again (FilePage listens for this, as for the app's own assistant). */
function fileChanged(id, server) {
  for (const win of server.windows) {
    void win.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('stored-file-changed', { detail: ${JSON.stringify(id)} }))`).catch(() => {});
  }
}

async function connectAgent() {
  const command = `claude mcp add --scope user --transport http mcp-docs ${MCP_URL}/mcp`;
  const agents = mcpAuth?.clients() ?? [];
  const connected = agents.length ? `Connected now: ${agents.map((a) => a.name).join(', ')}.` : 'No agent is connected yet.';
  const res = await dialog.showMessageBox({
    type: 'info',
    title: 'Connect an Agent',
    message: mcpListening ? 'Agents on this computer can read and edit the open folder’s files, and the app shows what they open.' : `The MCP server is not running: port ${MCP_PORT} is in use, probably by another copy of the app.`,
    detail: `MCP server (MCP Docs): ${MCP_URL}/mcp\n\nTo add it to Claude Code, run the command below (or install the mcp-docs plugin with: npx @scottpersinger/mcp-docs), then /mcp in Claude Code to sign in. The app asks you to allow each agent that connects.\n\n${command}\n\n${connected}`,
    buttons: agents.length ? ['Copy Command', 'Disconnect All Agents', 'Close'] : ['Copy Command', 'Close'],
    defaultId: 0,
    cancelId: agents.length ? 2 : 1,
  });
  if (res.response === 0) clipboard.writeText(command);
  if (agents.length && res.response === 1) mcpAuth.revokeAll();
}

// --- The assistant's API keys ------------------------------------------------------------------------------
// The app has no model of its own: the assistant runs on the user's Anthropic, OpenAI or OpenRouter key. On
// the first run a key already set where the user works is used (the server keeps it once it has settings,
// server/agent/settings.ts). Started from Finder or the Dock, the app does not get the login shell's
// environment, so it is read from the shell, once.
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
const keysCheckedFile = () => path.join(app.getPath('userData'), 'assistant-keys-checked');
let shellKeys = {};

/** The keys set in the user's login shell (or already in this process's environment), by name. */
function readShellKeys() {
  const found = Object.fromEntries(KEY_NAMES.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  if (process.platform === 'win32') return Promise.resolve(found);
  return new Promise((resolve) => {
    // An interactive login shell reads the same files a terminal does (.zprofile, .zshrc, ...).
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'env'], { timeout: 5000, maxBuffer: 1 << 20 }, (_e, out) => {
      for (const line of String(out ?? '').split('\n')) {
        const m = /^([A-Z_]+)=(\S+)$/.exec(line);
        if (m && KEY_NAMES.includes(m[1]) && !found[m[1]]) found[m[1]] = m[2];
      }
      resolve(found);
    });
  });
}

/** The server for a folder: the one running, or a new one once it is listening. */
function serverFor(dir) {
  const running = servers.get(dir);
  if (running) return Promise.resolve(running);
  if (!starting.has(dir)) {
    const start = startServer(dir).finally(() => starting.delete(dir));
    starting.set(dir, start);
  }
  return starting.get(dir);
}

/** Start a server for the folder; resolves once it is listening. */
async function startServer(dir) {
  const token = randomBytes(32).toString('base64url');
  // Cookies are per host, not per port: each folder's server has a cookie of its own on 127.0.0.1.
  const cookie = `local-${randomBytes(6).toString('hex')}`;
  // What the app keeps for a folder (chat history, settings, pasted images, deleted files) lives with the
  // app's own data, not in the folder.
  const dataDir = path.join(app.getPath('userData'), 'folders', createHash('sha256').update(dir).digest('hex').slice(0, 16));
  // Electron runs as plain Node in a forked child. The working directory is the app's, where .env is.
  const child = fork(path.join(root, 'desktop', 'server.ts'), [], {
    cwd: root,
    env: { ...process.env, ...shellKeys, LOCAL_DIR: dir, DATA_DIR: dataDir, APP_DATA_DIR: app.getPath('userData'), LOCAL_TOKEN: token, LOCAL_COOKIE: cookie, PORT: '0', MCP_TOKEN: MCP_SECRET, MCP_URL },
  });
  const server = await new Promise((resolve, reject) => {
    child.once('message', (msg) => resolve({ child, dir, token, cookie, port: msg.port, origin: `http://127.0.0.1:${msg.port}`, windows: new Set() }));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`The server stopped while starting (exit code ${code}).`)));
  });
  child.removeAllListeners('error');
  child.removeAllListeners('exit');
  child.on('error', () => {}); // It stopping is what counts, below.
  const failed = (e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e));
  // Later the server asks, for the window it serves that the person is using, for a file outside its folder to
  // be shown (one of Recents), another folder, or a page (a file an agent opened).
  child.on('message', (msg) => {
    if (msg && typeof msg.openFile === 'string') void openFile(msg.openFile, msg.fromRecents !== false, windowFor(server)).catch(failed);
    if (msg && typeof msg.openFolder === 'string') void openFolder(msg.openFolder, '/', windowFor(server)).catch(failed);
    if (msg?.chooseFolder) void chooseFolder(windowFor(server)).catch(failed);
    if (msg?.connectAgent) void connectAgent().catch(failed);
    if (msg && typeof msg.show === 'string' && msg.show.startsWith('/')) showPage(msg.show, server);
    if (msg && typeof msg.fileChanged === 'string') fileChanged(msg.fileChanged, server);
  });
  child.once('exit', () => {
    servers.delete(dir);
    dialog.showErrorBox('MCP Docs', `The local server for “${dir}” stopped unexpectedly. Its windows will close.`);
    for (const win of [...server.windows]) win.destroy();
  });
  // Only this app's windows hold the token, so nothing else on the machine can use the server.
  await session.defaultSession.cookies.set({ url: server.origin, name: cookie, value: token, httpOnly: true, sameSite: 'strict' });
  servers.set(dir, server);
  return server;
}

const TABS = 'freeflow';
const WINDOW_OPTIONS = { width: 1400, height: 900, title: 'MCP Docs', tabbingIdentifier: TABS };

/** Keep track of a window of the app: which folder it shows, and when it is the one in front. */
function track(win, server) {
  const id = win.id;
  attach(win, server);
  // index.html is titled with the hosted app's name until the page learns it is this app (client/src/brand.ts).
  win.on('page-title-updated', (e, title) => title === 'Universal Docs' && e.preventDefault());
  win.on('focus', () => {
    front = win;
    const s = serverOf(win);
    if (s) rememberFolder(s.dir);
  });
  win.once('closed', () => detach(id, win));
}

/** A window on `url` of `server`'s folder; with `tabOf`, a tab of that window where the system has them (macOS). */
function createWindow(server, url, tabOf = null) {
  const win = new BrowserWindow(WINDOW_OPTIONS);
  track(win, server);
  if (tabOf && !tabOf.isDestroyed() && process.platform === 'darwin') tabOf.addTabbedWindow(win);
  void win.loadURL(url);
  return win;
}

// "Open in a new tab" (window.open) opens another window of the app, as a tab of the window it came from
// where the system has window tabs (macOS), on the same folder; links to anywhere else go to the browser.
const serverAt = (url) => [...servers.values()].find((s) => url.startsWith(`${s.origin}/`));
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (serverAt(target)) return { action: 'allow', overrideBrowserWindowOptions: WINDOW_OPTIONS };
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  // The right-click menu a browser would show (desktop/contextMenu.js).
  contents.on('context-menu', (_e, params) => {
    const template = contextMenuTemplate(params, {
      copyImage: () => contents.copyImageAt(params.x, params.y),
      copyText: (text) => clipboard.writeText(text),
      saveImage: (url) => contents.downloadURL(url),
      openLink: (url) => void shell.openExternal(url),
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      learnSpelling: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      inspect: app.isPackaged ? undefined : () => contents.inspectElement(params.x, params.y),
    });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
  contents.on('did-create-window', (child, { url }) => {
    const opener = BrowserWindow.fromWebContents(contents);
    const server = serverOf(opener) ?? serverAt(url);
    if (server) track(child, server);
    if (process.platform === 'darwin' && opener) opener.addTabbedWindow(child);
  });
});

/**
 * Show `dir` in `win` (the window it was opened from), or in a new window (a tab of the one in front) when
 * there is none. Other windows keep their folders. `landing` is the page the window starts on.
 */
async function openFolder(dir, landing = '/', win = null) {
  const server = await serverFor(path.resolve(dir));
  rememberFolder(server.dir);
  if (win && !win.isDestroyed()) {
    attach(win, server);
    void win.loadURL(`${server.origin}${landing}`);
  } else createWindow(server, `${server.origin}${landing}`, front);
}

/**
 * Show a file that is not in the window's folder: its own folder becomes the window's (or a new tab's, with
 * no window), and the window starts on the file. One of Recents (`fromRecents`) keeps Recents as the list its
 * breadcrumbs lead back to.
 */
async function openFile(file, fromRecents = true, win = null) {
  if (!isDir(path.dirname(file))) throw new Error(`"${file}" is no longer there.`);
  await openFolder(path.dirname(file), `/open?file=${encodeURIComponent(path.basename(file))}${fromRecents ? '&from=recents' : ''}`, win);
}

/** Show a file the system asked the app to open (Finder): in the folder in front when it is there, else in a new tab on its own folder. */
async function showFile(file) {
  const current = frontServer();
  const rel = current ? path.relative(current.dir, file) : '';
  const parts = rel.split(path.sep);
  // The open folder's server lists no hidden files or folders, so a file among them opens in its own folder.
  if (rel && !path.isAbsolute(rel) && !parts.some((p) => p === '..' || p.startsWith('.'))) showPage(`/open?file=${encodeURIComponent(parts.join('/'))}`, current);
  else await openFile(file, false);
}

/**
 * A new tab beside the window in front, on its folder, showing the list it shows: its folder within the
 * folder, or Recents. A file's page names the list it came from (client/src/listing.ts).
 */
async function newTab() {
  const win = BrowserWindow.getFocusedWindow() ?? front;
  const server = serverOf(win) ?? frontServer();
  if (!server) return openFolder(lastFolder() ?? app.getPath('home'));
  let listing = '/';
  try {
    listing = await win.webContents.executeJavaScript(`(() => {
      const q = new URLSearchParams(location.pathname === '/' ? location.search : sessionStorage.getItem('ui.lastListing') ?? '');
      if (q.get('recents') === '1') return '/?recents=1';
      const folder = q.get('folder');
      return folder ? '/?folder=' + encodeURIComponent(folder) : '/';
    })()`);
  } catch {
    // The top of the folder, then.
  }
  createWindow(server, `${server.origin}${listing}`, win).focus();
}

// Finder asks for a file (a double-click when the app is the file's default, Open With, a file dropped on the
// Dock icon) with open-file, which comes before the app is ready when that is what started it.
let launchFile = null;
let started = false;
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (!started) launchFile = file;
  else void showFile(file).catch((err) => dialog.showErrorBox('MCP Docs', String(err.message ?? err)));
});

// --- Default app (macOS) ----------------------------------------------------------------------------------
// The app owns its own formats, but for the standard ones the system prefers Apple's apps whatever the app
// declares, so becoming their default is the person's choice, set as Get Info › Change All… would set it.
const DEFAULT_TYPES = [
  'org.openxmlformats.wordprocessingml.document',
  'org.openxmlformats.spreadsheetml.sheet',
  'com.microsoft.excel.xls',
  'org.openxmlformats.presentationml.presentation',
  'com.adobe.pdf',
  'public.comma-separated-values-text',
  'net.daringfireball.markdown',
];
const canBeDefault = () => process.platform === 'darwin' && app.isPackaged;
const defaultAskedFile = () => path.join(app.getPath('userData'), 'default-app-asked');

/**
 * Make the app (its bundle id is `build.appId` in package.json) the default for DEFAULT_TYPES, with
 * LSSetDefaultRoleHandlerForContentType through JavaScript for Automation. Each call answers 0 when it worked.
 */
function setDefaultApp() {
  const script = `ObjC.import('CoreServices');
ObjC.bindFunction('LSSetDefaultRoleHandlerForContentType', ['int', ['id', 'unsigned int', 'id']]);
${JSON.stringify(DEFAULT_TYPES)}.map((t) => $.LSSetDefaultRoleHandlerForContentType($(t), 0xFFFFFFFF, $('im.freeflow.docs'))).join(',')`;
  return new Promise((resolve, reject) =>
    execFile('osascript', ['-l', 'JavaScript', '-e', script], (e, out) => {
      if (e) return reject(e);
      const failed = out.trim().split(',').filter((code) => code !== '0').length;
      if (failed) reject(new Error(`${failed} of the ${DEFAULT_TYPES.length} file types could not be changed.`));
      else resolve();
    }),
  );
}

/** Ask, then make the app the default. `first` is the one offer at the first start, which can be declined for good. */
async function offerDefaultApp(first = false) {
  const res = await dialog.showMessageBox({
    type: 'question',
    title: 'Default App',
    message: 'Open Word, Excel, PowerPoint, PDF, CSV and Markdown files in MCP Docs?',
    detail: 'Double-clicking one of these files in Finder will open it here. You can change it back for a type with Get Info › Open with › Change All… in Finder.',
    buttons: [first ? 'Use MCP Docs' : 'Make Default', first ? 'Not Now' : 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (first) {
    try {
      writeFileSync(defaultAskedFile(), '');
    } catch {
      // Asked again next time, that's all.
    }
  }
  if (res.response !== 0) return;
  try {
    await setDefaultApp();
  } catch (e) {
    dialog.showErrorBox('MCP Docs', `The app could not be made the default: ${e.message ?? e}`);
  }
}

/** Ask for a folder and show it in `win` (the window it was asked from), or in a new window with none. */
async function chooseFolder(win = null) {
  const options = { title: 'Open folder', properties: ['openDirectory', 'createDirectory'], defaultPath: serverOf(win)?.dir ?? app.getPath('documents') };
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (res.canceled || !res.filePaths[0]) return false;
  await openFolder(res.filePaths[0], '/', win);
  return true;
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac
        ? [
            {
              role: 'appMenu',
              submenu: [
                { role: 'about' },
                ...(canBeDefault() ? [{ type: 'separator' }, { label: 'Make Default App…', click: () => void offerDefaultApp() }] : []),
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => void newTab().catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))) },
          {
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => {
              const server = frontServer();
              if (server) createWindow(server, `${server.origin}/`);
            },
          },
          { type: 'separator' },
          { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void chooseFolder(BrowserWindow.getFocusedWindow()).catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))) },
          { label: mac ? 'Show Folder in Finder' : 'Show Folder', click: () => frontServer() && void shell.openPath(frontServer().dir) },
          { type: 'separator' },
          { label: 'Connect an Agent (MCP)…', click: () => void connectAgent() },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showPage('/settings') },
          { type: 'separator' },
          mac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

app.whenReady().then(async () => {
  buildMenu();
  startMcpProxy();
  if (!existsSync(path.join(root, 'dist', 'client', 'index.html'))) {
    dialog.showErrorBox('MCP Docs', 'The app has not been built yet. Run "npm run build" in the project, then start it again.');
    return app.quit();
  }
  if (!existsSync(keysCheckedFile())) {
    shellKeys = await readShellKeys();
    try {
      writeFileSync(keysCheckedFile(), '');
    } catch {
      // Looked for again next time, that's all.
    }
  }
  // electron [flags] desktop/main.js [folder]: the folder is the argument that is neither a flag nor this script.
  const arg = process.argv.slice(1).find((a) => !a.startsWith('-') && path.resolve(a) !== import.meta.filename);
  try {
    if (launchFile) {
      await openFile(launchFile, false);
      return;
    }
    if (!arg && app.isPackaged) {
      await openFolder(lastFolder() ?? app.getPath('home'));
      return;
    }
    const dir = path.resolve(arg ?? process.cwd());
    if (isDir(dir)) await openFolder(dir);
    else {
      dialog.showErrorBox('MCP Docs', `"${dir}" is not a folder. Choose a folder to open.`);
      if (!(await chooseFolder())) app.quit();
    }
  } catch (e) {
    dialog.showErrorBox('MCP Docs', `The app could not start: ${e.message ?? e}`);
    app.quit();
  } finally {
    started = true;
    // The installed app offers once to open the standard formats too.
    if (servers.size && canBeDefault() && !existsSync(defaultAskedFile())) void offerDefaultApp(true);
  }
});

// With no window left (on macOS the app keeps running), the Dock icon opens the folder last in front.
app.on('activate', () => {
  if (started && BrowserWindow.getAllWindows().length === 0) void openFolder(lastFolder() ?? app.getPath('home')).catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e)));
});
// The + in the tab bar (macOS).
app.on('new-window-for-tab', () => void newTab().catch((e) => dialog.showErrorBox('MCP Docs', String(e.message ?? e))));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', stopServers);
