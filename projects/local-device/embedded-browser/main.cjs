const { app, BaseWindow, Menu, WebContentsView, ipcMain, session } = require('electron');
const fs = require('node:fs');
const { isAbsolute, resolve } = require('node:path');
const { TabManager, webURL } = require('./agent/tabs.cjs');
const { createEngine } = require('./agent/actions.cjs');

const profilePrefix = '--connector-browser-profile=';
const profile =
  process.argv
    .find((argument) => argument.startsWith(profilePrefix))
    ?.slice(profilePrefix.length) ??
  (process.argv.at(-2) === __filename ? process.argv.at(-1) : undefined);
if (!profile || !isAbsolute(profile)) process.exit(2);
// Windows 的 GUI 进程拿不到可用的 stdio：连接器会传入用户级命名管道与一次性 token。
const pipePrefix = '--connector-browser-pipe=';
const tokenPrefix = '--connector-browser-token=';
const pipeName = process.argv.find((argument) => argument.startsWith(pipePrefix))?.slice(pipePrefix.length);
const pipeToken =
  process.argv.find((argument) => argument.startsWith(tokenPrefix))?.slice(tokenPrefix.length) ?? '';
app.setName('伯仁连接器');
app.setPath('userData', resolve(profile));
app.enableSandbox();

// GUI 进程没有控制台：关键事件落盘到 profile/ui.log，便于排查白屏、加载失败与渲染进程崩溃。
const logPath = resolve(profile, 'ui.log');
function log(message) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) fs.writeFileSync(logPath, '');
    fs.appendFileSync(logPath, new Date().toISOString() + ' ' + message + '\n');
  } catch {}
}
function trace(label, contents, { consoleMessages = false } = {}) {
  contents.on('did-finish-load', () => log(label + ' finish ' + contents.getURL().slice(0, 200)));
  contents.on('dom-ready', () => log(label + ' dom-ready'));
  contents.on('did-fail-load', (_e, code, description, url) =>
    log(label + ' fail ' + code + ' ' + description + ' ' + String(url).slice(0, 200))
  );
  contents.on('render-process-gone', (_e, details) =>
    log(label + ' gone ' + details.reason + ' exit=' + details.exitCode)
  );
  contents.on('preload-error', (_e, path, error) =>
    log(label + ' preload-error ' + path + ' ' + (error?.message ?? ''))
  );
  contents.on('unresponsive', () => log(label + ' unresponsive'));
  if (!consoleMessages) return;
  contents.on('console-message', (details) => {
    // Electron 45 起该事件为单参数对象；兼容旧签名的 level/message 字段。
    const level = details?.level ?? 0;
    const severity = typeof level === 'string'
      ? { verbose: 0, info: 1, warning: 2, error: 3 }[level] ?? 0
      : Number(level) || 0;
    if (severity >= 2) log(label + ' console[' + severity + '] ' + String(details?.message ?? '').slice(0, 300));
  });
}
app.on('child-process-gone', (_e, details) =>
  log('child-process-gone ' + details.type + ' ' + details.reason + ' exit=' + details.exitCode)
);
log('start argv=' + process.argv.slice(1).map((a) => a.replace(/=.*token.*=/i, '=<redacted>')).join(' ').slice(0, 300));

const chromeHeight = process.platform === 'darwin' ? 88 : 82;
const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false };

async function openWindow() {
  // Dock 和 App Exposé 必须指向实际持有窗口的进程。关闭窗口时该进程退出，托盘继续运行。
  if (process.platform === 'darwin') await app.dock.show();
  Menu.setApplicationMenu(null);
  const browsingSession = session.fromPartition('persist:connector-browser');
  browsingSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  browsingSession.setPermissionCheckHandler(() => false);
  const integrated = true;
  const window = new BaseWindow({
    title: integrated ? '伯仁连接器' : app.getName(),
    width: 1160,
    height: 780,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 13 } } : {})
  });
  let manage = false;
  let paused = false;
  const toolbar = new WebContentsView({
    webPreferences: { ...webPreferences, preload: resolve(__dirname, 'preload.cjs') }
  });
  window.contentView.addChildView(toolbar);
  trace('toolbar', toolbar.webContents, { consoleMessages: true });
  window.on('show', () => log('window show'));
  window.on('hide', () => log('window hide'));
  window.on('minimize', () => log('window minimize'));
  window.on('closed', () => log('window closed'));

  const tracedTabs = new Set();
  const invalidate = () => {
    // tabs.list() 返回的是给工具栏用的摘要对象，这里要取真实的 tab 实例。
    for (const contents of [toolbar.webContents, ...(tabs.tabs ?? []).map((tab) => tab.contents)]) {
      if (contents && !contents.isDestroyed()) contents.invalidate();
    }
  };

  const update = () => {
    if (toolbar.webContents.isDestroyed()) return;
    const list = tabs.list();
    for (const tab of tabs.tabs ?? []) {
      if (tracedTabs.has(tab.id)) continue;
      tracedTabs.add(tab.id);
      trace('tab#' + tab.id, tab.contents);
    }
    const active = list.find((tab) => tab.active);
    toolbar.webContents.send('browser-state', {
      paused,
      integrated,
      manage,
      url: active?.url ?? '',
      tabs: list.map(({ id, title, url, active: selected, loading }) => ({
        id,
        title: title || url || '新标签页',
        active: selected,
        loading
      }))
    });
  };
  const tabs = new TabManager({
    window,
    toolbarView: toolbar,
    session: browsingSession,
    webPreferences: {
      ...webPreferences,
      session: browsingSession,
      preload: resolve(__dirname, 'pointer.cjs')
    },
    onChange: () => update()
  });
  let lastLayout = '';
  const layout = () => {
    const { width, height } = window.getContentBounds();
    const toolbarHeight = integrated ? chromeHeight : 48;
    toolbar.setBounds({ x: 0, y: 0, width, height: manage ? height : toolbarHeight });
    tabs.layout(
      { x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) },
      !manage
    );
    const signature = width + 'x' + height + ' manage=' + manage;
    if (signature !== lastLayout) {
      lastLayout = signature;
      log('layout ' + signature);
    }
  };
  window.on('resize', layout);
  layout();

  const engine = createEngine({
    tabs,
    hooks: {
      pointer: (tab, payload) => {
        if (!tab.contents.isDestroyed()) tab.contents.send('agent-pointer', payload);
      }
    }
  });

  toolbar.webContents.on('will-navigate', (event) => event.preventDefault());
  toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let write = (data) => process.stdout.write(data);
  const reply = (result) => write(JSON.stringify(result) + '\0');
  let managementPending = false;
  const requestManagement = (action = '') => {
    if (!integrated || managementPending || typeof action !== 'string' || action.length > 2048)
      return;
    managementPending = true;
    reply({ managementAction: action });
  };
  const switchView = (management) => {
    manage = integrated && management;
    layout();
    update();
    // 视图显隐后强制合成一帧，避免 Windows 上停在旧画面或整窗白色。
    invalidate();
    if (manage) requestManagement();
  };
  app.on('activate', () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    invalidate();
  });
  ipcMain.on('browser-control', (event, action, value) => {
    if (event.sender !== toolbar.webContents || event.senderFrame !== toolbar.webContents.mainFrame)
      return;
    const contents = tabs.active?.contents;
    if (action === 'show-management') switchView(true);
    if (action === 'show-browser') switchView(false);
    if (action === 'management' && manage) requestManagement(value);
    if (action === 'pause') {
      paused = !paused;
      update();
    }
    if (action === 'navigate' && contents) {
      const url = webURL(value);
      if (url) void contents.loadURL(url).catch(update);
    }
    if (action === 'back' && contents?.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    if (action === 'reload') contents?.reload();
    if (action === 'new-tab') {
      if (manage) switchView(false);
      void tabs.create();
    }
    if (action === 'select-tab' && Number.isInteger(value)) {
      if (manage) switchView(false);
      tabs.select(value);
      invalidate();
    }
    if (action === 'close-tab' && Number.isInteger(value)) {
      void tabs.close(value);
      invalidate();
    }
  });

  await toolbar.webContents.loadFile(resolve(__dirname, 'toolbar.html'));
  await tabs.create();
  update();
  log('initial load complete tabs=' + tabs.list().length);
  invalidate();

  let pending = '';
  let executing = false;
  const consume = (chunk) => {
    pending += chunk;
    if (pending.length > 1024 * 1024) return app.quit();
    let separator;
    while ((separator = pending.indexOf('\0')) >= 0) {
      let request;
      try {
        request = JSON.parse(pending.slice(0, separator));
      } catch {
        return app.quit();
      }
      pending = pending.slice(separator + 1);
      void handle(request);
    }
  };
  if (pipeName) {
    const net = require('node:net');
    const socket = net.connect(pipeName);
    write = (data) => socket.write(data);
    socket.setEncoding('utf8');
    socket.write(JSON.stringify({ token: pipeToken }) + '\0');
    socket.on('data', consume);
    socket.on('error', () => app.quit());
    socket.on('close', () => app.quit());
    log('transport pipe');
  } else {
    // macOS 使用继承的 stdio。
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', consume);
    process.stdin.on('end', () => app.quit());
    log('transport stdio');
  }

  /** 处理 Go 连接器发来的一条私有 stdio 请求。 */
  async function handle({ id, method, params }) {
    if (method === 'Browser.close') {
      reply({ id, result: {} });
      return app.quit();
    }
    if (method === 'Connector.focus') {
      if (typeof params?.management === 'boolean') switchView(params.management);
      window.show();
      window.focus();
      invalidate();
      log('Connector.focus management=' + (params?.management ?? false));
      return reply({ id, result: {} });
    }
    if (method === 'Connector.managementSnapshot') {
      managementPending = false;
      if (!toolbar.webContents.isDestroyed()) toolbar.webContents.send('management-state', params);
      return reply({ id, result: {} });
    }
    if (method === 'Connector.ready') {
      return reply({
        id,
        result: { title: window.getTitle(), dockVisible: app.dock?.isVisible() ?? false }
      });
    }
    if (method !== 'Agent.run' || !params || typeof params.action !== 'string') {
      return reply({ id, error: { message: 'browser_operation_rejected' } });
    }
    if (paused) return reply({ id, error: { message: 'browser_paused' } });
    if (executing) return reply({ id, error: { message: 'browser_busy' } });
    executing = true;
    const started = Date.now();
    try {
      if (manage) switchView(false);
      const activeContents = tabs.active?.contents;
      if (activeContents && !activeContents.isDestroyed() && !activeContents.isFocused()) {
        activeContents.focus();
      }
      const result = await engine.run(params);
      log('Agent.run ' + params.action + ' ok ' + (Date.now() - started) + 'ms');
      reply({ id, result });
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : 'browser_operation_rejected';
      log('Agent.run ' + params.action + ' error ' + message.slice(0, 200));
      reply({ id, error: { message } });
    } finally {
      executing = false;
    }
  }

  window.on('closed', () => {
    tabs.closeAll();
    toolbar.webContents.close();
    app.quit();
  });
}

app
  .whenReady()
  .then(openWindow)
  .catch((error) => {
    console.error('Embedded browser startup failed:', error?.name ?? 'Error');
    app.exit(1);
  });
