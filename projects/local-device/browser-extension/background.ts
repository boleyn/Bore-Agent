/// <reference types="chrome" />

type SharedTab = {
  target: chrome.debugger.Debuggee;
  origin: string;
  port: chrome.runtime.Port;
  refs: Map<string, number>;
  snapshot: number;
  busy: boolean;
  state: 'pending' | 'attaching' | 'attached';
};

const sharedTabProtocolVersion = 1;
let shared: SharedTab | undefined;

async function stop(session: SharedTab) {
  if (shared !== session) return;
  shared = undefined;
  session.port.disconnect();
  if (session.state === 'attached') {
    await chrome.debugger.detach(session.target).catch(() => {});
  }
  await chrome.action.setBadgeText({ tabId: session.target.tabId, text: '' }).catch(() => {});
}

async function shareActiveTab(tab: chrome.tabs.Tab) {
  if (shared) {
    await stop(shared);
    return;
  }
  if (tab.id === undefined || !tab.url || !URL.canParse(tab.url)) return;
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  const port = chrome.runtime.connectNative('ai.studio.browser');
  const session: SharedTab = {
    target: { tabId: tab.id },
    origin: url.origin,
    port,
    refs: new Map(),
    snapshot: 0,
    busy: false,
    state: 'pending'
  };
  shared = session;
  port.onDisconnect.addListener(() => {
    // Reading lastError prevents Chrome from reporting an unchecked API error.
    void chrome.runtime.lastError;
    void stop(session);
  });
  port.onMessage.addListener(
    (message: {
      type?: string;
      version?: number;
      error?: string;
      id?: number;
      request?: BrowserAction;
    }) => {
      if (
        shared === session &&
        session.state === 'attached' &&
        message.type === 'action' &&
        typeof message.id === 'number' &&
        Number.isSafeInteger(message.id) &&
        message.request
      ) {
        void reply(session, message.id, message.request);
        return;
      }
      if (shared !== session || session.state !== 'pending') return;
      if (
        message.error === 'browser_extension_version_mismatch' ||
        (message.type === 'approved' && message.version !== sharedTabProtocolVersion)
      ) {
        void stop(session)
          .then(() =>
            chrome.action.setTitle({
              tabId: session.target.tabId,
              title: 'AI Studio：请将连接器和扩展更新到匹配的版本'
            })
          )
          .catch(() => {});
        return;
      }
      if (message.type !== 'approved') return;
      session.state = 'attaching';
      void attach(session);
    }
  );
  port.postMessage({ type: 'offer', origin: url.origin, version: sharedTabProtocolVersion });
}

chrome.action.onClicked.addListener(shareActiveTab);

async function attach(session: SharedTab) {
  try {
    const tab = await chrome.tabs.get(session.target.tabId!);
    if (shared !== session || !tab.url || new URL(tab.url).origin !== session.origin) {
      await stop(session);
      return;
    }
    await chrome.debugger.attach(session.target, '1.3');
    if (shared !== session) {
      await chrome.debugger.detach(session.target).catch(() => {});
      return;
    }
    session.state = 'attached';
    session.port.postMessage({ type: 'ready' });
    await chrome.action.setBadgeText({ tabId: session.target.tabId, text: 'ON' });
  } catch {
    await stop(session);
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (shared && shared.target.tabId === source.tabId) void stop(shared);
});

chrome.tabs.onUpdated.addListener((id, change) => {
  const session = shared;
  if (!session || session.target.tabId !== id) return;
  if (change.status === 'loading') session.refs.clear();
  if (!change.url) return;
  if (!URL.canParse(change.url) || new URL(change.url).origin !== session.origin) {
    void stop(session);
  }
});

chrome.tabs.onRemoved.addListener((id) => {
  if (shared && shared.target.tabId === id) void stop(shared);
});

type BrowserAction =
  | { action: 'snapshot'; offset?: number }
  | { action: 'reload' | 'screenshot' }
  | { action: 'navigate'; url: string }
  | { action: 'click'; ref: string }
  | { action: 'fill' | 'matches'; ref: string; text: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; deltaY: number };

async function command<T>(session: SharedTab, method: string, params?: Record<string, unknown>) {
  if (shared !== session) throw new Error('browser_unavailable');
  const tab = await chrome.tabs.get(session.target.tabId!);
  if (shared !== session || !tab.url || new URL(tab.url).origin !== session.origin) {
    throw new Error('browser_site_approval_required');
  }
  return (await chrome.debugger.sendCommand(session.target, method, params)) as T;
}

async function reply(session: SharedTab, id: number, action: BrowserAction) {
  if (session.busy) {
    session.port.postMessage({ type: 'result', id, error: 'browser_busy' });
    return;
  }
  session.busy = true;
  try {
    const result = await execute(session, action);
    if (shared === session) session.port.postMessage({ type: 'result', id, result });
  } catch (error) {
    const known = [
      'browser_site_approval_required',
      'browser_snapshot_required',
      'browser_element_unavailable'
    ];
    const code =
      error instanceof Error && known.includes(error.message)
        ? error.message
        : 'browser_operation_rejected';
    if (shared === session) session.port.postMessage({ type: 'result', id, error: code });
  } finally {
    session.busy = false;
  }
}

async function execute(session: SharedTab, action: BrowserAction) {
  switch (action.action) {
    case 'navigate': {
      const url = new URL(action.url);
      if (url.origin !== session.origin || url.username || url.password) {
        throw new Error('browser_site_approval_required');
      }
      session.refs.clear();
      const result = await command<{ errorText?: string; isDownload?: boolean }>(
        session,
        'Page.navigate',
        { url: url.href }
      );
      if (result.errorText || result.isDownload) throw new Error('browser_navigation_failed');
      return { navigated: true };
    }
    case 'reload':
      session.refs.clear();
      return command(session, 'Page.reload');
    case 'snapshot': {
      session.refs.clear();
      const version = ++session.snapshot;
      const tree = await command<{
        nodes: Array<{
          nodeId: string;
          parentId?: string;
          ignored: boolean;
          role?: { value: string };
          name?: { value: string };
          backendDOMNodeId?: number;
        }>;
      }>(session, 'Accessibility.getFullAXTree');
      const offset = action.offset ?? 0;
      const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
      const rowNames = new Map(
        tree.nodes
          .filter((node) => node.role?.value === 'row')
          .map((node) => [node.nodeId, node.name?.value ?? ''])
      );
      for (const node of tree.nodes) {
        if (
          node.parentId &&
          rowNames.has(node.parentId) &&
          node.name?.value &&
          (node.role?.value === 'rowheader' ||
            (node.role?.value === 'cell' && !rowNames.get(node.parentId)))
        ) {
          rowNames.set(node.parentId, node.name.value);
        }
      }
      const controls = new Set([
        'textbox',
        'searchbox',
        'spinbutton',
        'combobox',
        'checkbox',
        'radio',
        'switch',
        'Date',
        'DateTime',
        'Time'
      ]);
      const entries = tree.nodes.filter(
        (node) =>
          !node.ignored && node.role?.value && (node.name?.value || controls.has(node.role.value))
      );
      const nodes = entries.slice(offset, offset + 100).map((node, index) => {
        const ref = node.backendDOMNodeId ? `e${version}_${index}` : undefined;
        if (ref && node.backendDOMNodeId) session.refs.set(ref, node.backendDOMNodeId);
        let parent = node.parentId;
        let row: string | undefined;
        for (let depth = 0; parent && depth < 64; depth++) {
          const ancestor = byId.get(parent);
          if (ancestor?.role?.value === 'row') {
            row = rowNames.get(parent)?.slice(0, 128);
            break;
          }
          parent = ancestor?.parentId;
        }
        return {
          role: node.role?.value.slice(0, 64),
          name: node.name?.value.slice(0, 256) ?? '',
          row,
          ref
        };
      });
      return { nodes, nextOffset: entries.length > offset + 100 ? offset + 100 : undefined };
    }
    case 'click':
    case 'matches':
    case 'fill':
      return elementAction(session, action);
    case 'scroll':
      return command(session, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 8,
        y: 8,
        deltaX: 0,
        deltaY: action.deltaY
      });
    case 'press': {
      const keys = new Map([
        ['Enter', 13],
        ['Tab', 9],
        ['Escape', 27],
        ['Backspace', 8],
        ['ArrowUp', 38],
        ['ArrowDown', 40]
      ]);
      const code = keys.get(action.key);
      if (!code) throw new Error('invalid_browser_key');
      const params = { key: action.key, code: action.key, windowsVirtualKeyCode: code };
      await command(session, 'Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' });
      return command(session, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    }
    case 'screenshot': {
      const screenshot = await command<{ data: string }>(session, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 65,
        captureBeyondViewport: false
      });
      if (screenshot.data.length > 760 * 1024) throw new Error('browser_screenshot_too_large');
      return screenshot;
    }
  }
}

async function elementAction(
  session: SharedTab,
  action: Extract<BrowserAction, { action: 'click' | 'fill' | 'matches' }>
) {
  const backendNodeId = session.refs.get(action.ref);
  if (!backendNodeId) throw new Error('browser_snapshot_required');
  const { object } = await command<{ object: { objectId: string } }>(session, 'DOM.resolveNode', {
    backendNodeId
  });
  try {
    const click =
      "function () { if (!this.isConnected || typeof this.click !== 'function' || this.matches(':disabled')) return false; this.click(); return true; }";
    const matches = `function (text) {
      if (this.isConnected && this.isContentEditable && !this.parentElement?.isContentEditable) {
        return this.innerText === text.replace(/\\r\\n?/g, '\\n') || (!text && !this.textContent);
      }
      if (!this.isConnected || !this.matches('textarea,select,input:not([type=password]):not([type=hidden]):not([type=file])')) return null;
      return this.value === text || (this.tagName === 'SELECT' && this.selectedOptions[0]?.label === text);
    }`;
    const fill = `async function (text) {
      // 通过 Chromium 编辑事务替换内容，让编辑器的 input 监听器同步业务模型。
      if (this.isContentEditable && !this.parentElement?.isContentEditable) {
        if (!this.isConnected || this.closest('[inert],[aria-readonly="true"],[aria-disabled="true"]')) return false;
        this.focus();
        if (this.getRootNode().activeElement !== this) return false;
        const doc = this.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(this);
        const selection = doc.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        const expected = text.replace(/\\r\\n?/g, '\\n');
        if (!expected && !range.collapsed) doc.execCommand('delete');
        const lines = expected.split(String.fromCharCode(10));
        for (let index = 0; index < lines.length; index++) {
          if (index) doc.execCommand('insertLineBreak');
          if (lines[index]) doc.execCommand('insertText', false, lines[index]);
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return this.isConnected && (this.innerText === expected || (!expected && !this.textContent));
      }
      if (!this.isConnected || !this.matches('input,textarea,select') || this.disabled || this.readOnly) return false;
      if (this.tagName === 'INPUT' && !['text','search','email','url','tel','password','number','date','datetime-local','month','week','time'].includes(this.type)) return false;
      this.focus();
      if (this.getRootNode().activeElement !== this) return false;
      let expected = text;
      if (this.tagName === 'SELECT') {
        if (this.multiple) return false;
        const options = Array.from(this.options).filter(option => !option.matches(':disabled') && (option.label === text || option.value === text));
        if (options.length !== 1) return false;
        expected = options[0].value;
        this.selectedIndex = options[0].index;
      } else {
        const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, text);
      }
      this.dispatchEvent(new Event('input', {bubbles: true}));
      this.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return this.isConnected && this.value === expected && this.validity.valid;
    }`;
    const reply = await command<{ result: { value?: boolean } }>(
      session,
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration:
          action.action === 'matches' ? matches : action.action === 'fill' ? fill : click,
        awaitPromise: true,
        arguments: action.action !== 'click' ? [{ value: action.text }] : [],
        returnByValue: true
      }
    );
    if (typeof reply.result.value === 'boolean' && action.action === 'matches')
      return { matches: reply.result.value };
    if (action.action === 'fill' && reply.result.value === false) return { applied: false };
    if (!reply.result.value) throw new Error('browser_element_unavailable');
    return { applied: true };
  } finally {
    await command(session, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
