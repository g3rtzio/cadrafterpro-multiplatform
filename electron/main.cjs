// Desktop window for development: Electron opens the Angular dev server (ng serve) in its own
// window, so the app runs like a desktop program with live reload.
//   npm run desktop        → starts ng serve and opens the window when it is ready
//   npm run electron       → only the window (ng serve already running)
// Another address: set CADRAFTER_URL (for example http://localhost:4300).
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const START_URL = process.env.CADRAFTER_URL || 'http://localhost:4200';
const RETRY_MS = 1000;

let win = null;

// One window only: opening it again focuses the one that is open
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
}

function start() {
  // The app has its own keyboard shortcuts (Ctrl+Z, Ctrl+O, Ctrl+S…): the default menu would take
  // them. macOS keeps a small menu so copy / paste and quit work there.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // Clipboard (Select Text > Copy) and file pickers need no prompt in the desktop app
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['clipboard-read', 'clipboard-sanitized-write', 'fileSystem'].includes(permission));
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

function createWindow() {
  const icon = ['public/favicon.ico', 'src/favicon.ico'].map(p => path.join(__dirname, '..', p)).find(p => fs.existsSync(p));
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 640,
    title: 'CadrafterPro',
    icon,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('closed', () => { win = null; });

  // The window's X (or Alt+F4 / Cmd+Q): the page asks to save documents with changes first.
  // window.cadrafterRequestClose() answers true when nothing needs saving; otherwise it shows
  // Save / Don't Save / Cancel and calls window.close() itself when every document is answered,
  // which comes back here and is asked again (by then nothing is left to save).
  let allowClose = false;
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    const askPage = 'typeof window.cadrafterRequestClose === "function" ? window.cadrafterRequestClose() : true';
    // A page that doesn't answer in 5 s (still loading, frozen) doesn't keep the window open
    const timeout = new Promise(resolve => setTimeout(() => resolve(true), 5000));
    Promise.race([win.webContents.executeJavaScript(askPage, true), timeout])
      .then(canClose => { if (canClose) closeNow(); })
      .catch(() => closeNow());                        // page not loaded or not answering: just close
  });
  const closeNow = () => {
    if (!win || win.isDestroyed()) return;
    allowClose = true;
    win.close();
  };

  // Links to other sites (API key pages, help) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(START_URL)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(START_URL)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  // Developer keys: Ctrl+Shift+I = DevTools, F5 / Ctrl+R = reload
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (ctrl && input.shift && key === 'i') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key === 'F5' || (ctrl && !input.shift && key === 'r')) {
      win.webContents.reload();
      event.preventDefault();
    }
  });

  load();
}

// ng serve may still be compiling: keep trying until it answers
function load() {
  if (!win) return;
  win.loadURL(START_URL).catch(() => {
    if (win) win.setTitle(`CadrafterPro: waiting for ${START_URL}…`);
    setTimeout(load, RETRY_MS);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
