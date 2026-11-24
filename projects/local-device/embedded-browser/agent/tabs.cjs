// 内置浏览器的多标签页管理。每个标签是一个 WebContentsView，并单独挂载 CDP debugger。
const { WebContentsView } = require('electron');

const MAX_NETWORK_ENTRIES = 200;
const CAPTURE_BODY_TYPES = new Set(['XHR', 'Fetch', 'Document']);

/** 在每个新文档加载前注入瞬时 UI 监听器（toast / alert / loading），用于捕获一闪而过的提示。 */
const TRANSIENT_OBSERVER_SCRIPT = `(() => {
  if (window.__fastgptUiObserver) return;
  window.__fastgptUiObserver = true;
  // DOM 变更计数：动作前后对比，用于判断点击是否真正产生了效果。
  window.__fastgptMutations = 0;
  const events = (window.__fastgptUiEvents = []);
  let seq = 0;
  const push = (kind, text) => {
    const clean = String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
    if (!clean && kind !== 'loading') return;
    const last = events[events.length - 1];
    if (last && last.kind === kind && last.text === clean && Date.now() - last.timestamp < 400) return;
    events.push({ id: ++seq, kind, text: clean, timestamp: Date.now() });
    if (events.length > 50) events.shift();
  };
  const inspect = (node) => {
    if (!node || node.nodeType !== 1) return;
    const cls = typeof node.className === 'string' ? node.className : '';
    const role = node.getAttribute('role') || '';
    if (role === 'alert' || /\\b(el-message|el-notification|ant-message|ant-notification|toast)\\b/i.test(cls) && !/el-message-box/.test(cls)) {
      push('toast', node.innerText || node.textContent);
      return;
    }
    if (role === 'status') {
      push('status', node.innerText || node.textContent);
    }
    if (/\\b(el-loading-mask|ant-spin-spinning|ivu-spin|vxe-loading)\\b/.test(cls)) {
      push('loading', node.innerText || 'loading');
    }
    if (node.querySelectorAll) {
      for (const child of node.querySelectorAll('[role=alert],[role=status],.el-message,.el-notification,.ant-message,.ant-notification')) {
        inspect(child);
      }
    }
  };
  const start = () => {
    const root = document.documentElement || document.body;
    if (!root) return setTimeout(start, 20);
    new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.target && rec.target.nodeType === 1 && (rec.target.hasAttribute('data-fastgpt-pointer') || rec.target.closest?.('[data-fastgpt-pointer]'))) continue;
        window.__fastgptMutations++;
        if (rec.type === 'childList') for (const n of rec.addedNodes) inspect(n);
      }
    }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'aria-expanded', 'aria-selected', 'aria-checked', 'hidden', 'disabled', 'open'] });
  };
  start();
})();`;

/** 仅允许普通网页文档，手动与 Agent 导航共用。 */
function webURL(input) {
  if (typeof input !== 'string' || input.length > 2048) return;
  const value = input.trim();
  if (!value) return;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : 'https://' + value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return url.href;
    }
  } catch {}
}

/**
 * 管理标签页的创建、切换、关闭以及每个标签的运行状态：
 * - refs：快照引用表，主文档导航后清空；
 * - inflight：进行中的网络请求，用于自动等待网络空闲；
 * - dialog：待处理的 alert/confirm/prompt。
 */
class TabManager {
  constructor({ window, toolbarView, session, webPreferences, onChange }) {
    this.window = window;
    this.toolbarView = toolbarView;
    this.session = session;
    this.webPreferences = webPreferences;
    this.onChange = onChange;
    this.tabs = [];
    this.active = null;
    this.nextId = 1;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.visible = true;
    // 记录 Agent 动作期间新打开的标签，用于在结果中提示
    this.openedDuringAction = [];
    // 引用编号在所有标签、所有文档间单调递增：ref 全局唯一，可直接路由到所属标签，
    // 且导航后旧 ref 不会与新文档的 ref 撞号而误点到别的元素。
    this.refCounter = 0;
  }

  /** 分配下一个全局唯一的引用序号。 */
  allocRef() {
    return ++this.refCounter;
  }

  /** 查找持有该引用的当前文档标签（仅匹配未导航的活跃 ref 表）。 */
  ownerOfRef(ref) {
    return this.tabs.find((tab) => tab.refs.byRef.has(ref));
  }

  /** 新建标签。opener 打开的链接默认切换过去，与普通浏览器一致。 */
  async create(url, { activate = true } = {}) {
    const view = new WebContentsView({ webPreferences: this.webPreferences });
    const contents = view.webContents;
    contents.setBackgroundThrottling(false);
    const tab = {
      id: this.nextId++,
      view,
      contents,
      refs: { byBackend: new Map(), byRef: new Map() },
      allocRef: () => this.allocRef(),
      inflight: new Map(),
      network: [],
      networkById: new Map(),
      trace: [],
      lastNetwork: Date.now(),
      dialog: null,
      document: 0,
      title: '',
      ready: null
    };
    this.tabs.push(tab);
    // 所有标签保持在同一视口区域渲染，前台标签置于顶层：
    // 若设为 setVisible(false)，Electron 会将后台标签 innerWidth/innerHeight 置 0，导致坐标命中与布局失效。
    this.window.contentView.addChildView(view, 0);
    view.setBounds(this.bounds);
    view.setVisible(this.visible);

    const resetDocument = () => {
      tab.document++;
      tab.refs = { byBackend: new Map(), byRef: new Map() };
      tab.inflight.clear();
    };
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) resetDocument();
      this.emit();
    });
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) {
      contents.on(event, () => this.emit());
    }
    contents.setWindowOpenHandler(({ url: target }) => {
      const href = webURL(target);
      if (href) {
        setImmediate(() => {
          this.create(href).then((opened) => this.openedDuringAction.push(opened.id)).catch(() => {});
        });
      }
      return { action: 'deny' };
    });
    const restrict = (event) => {
      if (!webURL(event.url)) event.preventDefault();
    };
    contents.on('will-navigate', restrict);
    contents.on('will-redirect', restrict);
    contents.on('destroyed', () => this.remove(tab));

    tab.ready = (async () => {
      await contents.loadURL('about:blank');
      contents.debugger.attach('1.3');
      contents.debugger.on('message', (_event, method, params) => {
        switch (method) {
          case 'Page.javascriptDialogOpening':
            tab.dialog = { type: params.type, message: String(params.message || '').slice(0, 1000), defaultPrompt: params.defaultPrompt };
            this.emit();
            break;
          case 'Page.javascriptDialogClosed':
            tab.dialog = null;
            break;
          case 'Network.requestWillBeSent': {
            // 只将 Document / XHR / Fetch 纳入网络空闲判定：字体/图片重试、统计信标不应拖慢每次交互等待 3 秒。
            if (['Document', 'XHR', 'Fetch'].includes(params.type)) tab.inflight.set(params.requestId, Date.now());
            if (['Document', 'XHR', 'Fetch'].includes(params.type)) tab.lastNetwork = Date.now();
            const url = params.request?.url || '';
            if (url.startsWith('http://') || url.startsWith('https://')) {
              let entry = tab.networkById.get(params.requestId);
              if (!entry) {
                entry = {
                  requestId: params.requestId,
                  url,
                  method: params.request.method,
                  type: params.type || 'Other',
                  requestHeaders: params.request.headers || {},
                  requestBody: params.request.postData ? String(params.request.postData).slice(0, 4096) : undefined,
                  timestamp: Date.now()
                };
                tab.networkById.set(params.requestId, entry);
                tab.network.push(entry);
                if (tab.network.length > MAX_NETWORK_ENTRIES) {
                  const dropped = tab.network.shift();
                  if (dropped) tab.networkById.delete(dropped.requestId);
                }
                if (params.request.hasPostData && !entry.requestBody && !tab.contents.isDestroyed()) {
                  tab.contents.debugger
                    .sendCommand('Network.getRequestPostData', { requestId: params.requestId })
                    .then((res) => {
                      if (res?.postData) entry.requestBody = String(res.postData).slice(0, 4096);
                    })
                    .catch(() => {});
                }
              }
            }
            break;
          }
          case 'Network.responseReceived': {
            const entry = tab.networkById.get(params.requestId);
            if (entry && params.response) {
              entry.status = params.response.status;
              entry.statusText = params.response.statusText;
              entry.mimeType = params.response.mimeType;
              entry.responseHeaders = params.response.headers || {};
            }
            break;
          }
          case 'Network.loadingFinished': {
            if (tab.inflight.delete(params.requestId)) tab.lastNetwork = Date.now();
            const entry = tab.networkById.get(params.requestId);
            if (entry) {
              entry.durationMs = Date.now() - entry.timestamp;
              const shouldCapture =
                CAPTURE_BODY_TYPES.has(entry.type) ||
                (entry.status >= 400) ||
                (entry.mimeType && /json|problem\+/i.test(entry.mimeType));
              if (shouldCapture && !tab.contents.isDestroyed()) {
                entry.bodyPromise = tab.contents.debugger
                  .sendCommand('Network.getResponseBody', { requestId: params.requestId })
                  .then((res) => {
                    if (res && !res.base64Encoded && typeof res.body === 'string') {
                      entry.responseBody = res.body.slice(0, 8192);
                      if (res.body.length > 8192) entry.responseBodyTruncated = res.body.length;
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    entry.bodyPromise = null;
                  });
              }
            }
            break;
          }
          case 'Network.loadingFailed': {
            if (tab.inflight.delete(params.requestId)) tab.lastNetwork = Date.now();
            const entry = tab.networkById.get(params.requestId);
            if (entry) {
              entry.durationMs = Date.now() - entry.timestamp;
              entry.error = params.errorText || 'failed';
              entry.canceled = !!params.canceled;
            }
            break;
          }
        }
      });
      contents.debugger.on('detach', () => {});
      for (const domain of ['Page.enable', 'DOM.enable', 'Accessibility.enable']) {
        await contents.debugger.sendCommand(domain).catch(() => {});
      }
      await contents.debugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 10 * 1024 * 1024,
        maxResourceBufferSize: 5 * 1024 * 1024
      }).catch(() => {});
      await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: TRANSIENT_OBSERVER_SCRIPT }).catch(() => {});
      await contents.debugger.sendCommand('Runtime.evaluate', { expression: TRANSIENT_OBSERVER_SCRIPT }).catch(() => {});
    })();
    await tab.ready;
    if (url) contents.loadURL(url).catch(() => {});
    if (activate || !this.active) this.select(tab.id);
    this.emit();
    return tab;
  }

  find(id) {
    return this.tabs.find((tab) => tab.id === id);
  }

  indexOf(tab) {
    return this.tabs.indexOf(tab);
  }

  raiseActive() {
    if (this.active) this.window.contentView.addChildView(this.active.view);
    if (this.toolbarView) this.window.contentView.addChildView(this.toolbarView);
  }

  select(id) {
    const tab = this.find(id);
    if (!tab) return;
    this.active = tab;
    // 把激活标签移到页面层最前，同时保持工具栏最顶、所有标签保有真实视口尺寸。
    this.raiseActive();
    for (const item of this.tabs) {
      item.view.setBounds(this.bounds);
      item.view.setVisible(this.visible);
    }
    this.emit();
    return tab;
  }

  /** 关闭标签。最后一个标签关闭时保留一个空白页，窗口不随之退出。 */
  async close(id) {
    const tab = this.find(id);
    if (!tab) return;
    if (this.tabs.length === 1) {
      await tab.contents.loadURL('about:blank').catch(() => {});
      return;
    }
    tab.contents.close();
    this.remove(tab);
  }

  remove(tab) {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    try {
      this.window.contentView.removeChildView(tab.view);
    } catch {}
    if (this.active === tab) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.active = null;
      if (next) this.select(next.id);
    }
    this.emit();
  }

  layout(bounds, visible) {
    this.bounds = bounds;
    this.visible = visible;
    for (const tab of this.tabs) {
      tab.view.setBounds(bounds);
      tab.view.setVisible(visible);
    }
    this.raiseActive();
  }

  list() {
    return this.tabs.map((tab, index) => {
      const url = tab.contents.isDestroyed() ? '' : tab.contents.getURL();
      return {
        index,
        id: tab.id,
        tabId: tab.id,
        title: tab.contents.isDestroyed() ? '' : tab.contents.getTitle() || '',
        url: url === 'about:blank' ? '' : url,
        active: tab === this.active,
        loading: !tab.contents.isDestroyed() && tab.contents.isLoading()
      };
    });
  }

  emit() {
    this.onChange?.();
  }

  closeAll() {
    for (const tab of [...this.tabs]) {
      if (!tab.contents.isDestroyed()) tab.contents.close();
    }
  }
}

module.exports = { TabManager, webURL };
