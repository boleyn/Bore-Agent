// Agent 动作引擎：把结构化动作翻译为 CDP / Electron 调用，并在动作后自动等待页面稳定。
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const scripts = require('./page-scripts.cjs');
const { snapshot, agentError } = require('./snapshot.cjs');
const { webURL } = require('./tabs.cjs');

const MUTATING = new Set([
  'navigate', 'go_back', 'go_forward', 'reload', 'click', 'hover', 'type', 'fill', 'select_option',
  'check', 'press', 'scroll', 'drag', 'upload_file', 'fill_form', 'wait_for', 'evaluate', 'tabs', 'dialog'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYS = {
  Enter: [13, '\r'], Tab: [9, '\t'], Escape: [27], Backspace: [8], Delete: [46], Insert: [45],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35],
  PageUp: [33], PageDown: [34], Space: [32, ' '], ' ': [32, ' ']
};
for (let i = 1; i <= 12; i++) KEYS['F' + i] = [111 + i];
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

/**
 * 创建动作引擎。
 * @param tabs TabManager
 * @param hooks.pointer(tab, payload) 可视化 Agent 指针
 * @param hooks.reveal() 切到浏览器视图并聚焦页面
 */
function createEngine({ tabs, hooks = {} }) {
  /** 带超时的 CDP 调用，避免页面卡死时动作无限等待。 */
  const cdpFor = (tab) => (method, params = {}, timeout = 15000) => {
    if (tab.contents.isDestroyed()) return Promise.reject(agentError('tab_closed', '标签页已关闭，请用 tabs list 查看'));
    return Promise.race([
      tab.contents.debugger.sendCommand(method, params),
      sleep(timeout).then(() => {
        throw agentError('timeout', method + ' 超时，页面可能卡住或有对话框未处理');
      })
    ]);
  };

  function current() {
    const tab = tabs.active;
    if (!tab) throw agentError('no_tab', '没有可用标签页');
    return tab;
  }

  /**
   * 决定动作作用的标签：显式 tabId > ref 所属标签 > 当前激活标签。
   * ref 全局唯一，因此 Agent 可以在多个标签间交替操作而无需反复 tabs select；
   * 非激活标签在后台执行，不打断用户正在看的页面。
   */
  function targetTab(action) {
    if (action.tabId !== undefined) {
      const tab = tabs.find(action.tabId);
      if (!tab) throw agentError('tab_not_found', '没有 tabId=' + action.tabId + ' 的标签页，请用 tabs list 查看');
      return tab;
    }
    const ref = action.ref || action.startRef || action.fields?.[0]?.ref;
    if (ref) {
      const owner = tabs.ownerOfRef(ref);
      if (owner) return owner;
    }
    return current();
  }

  /** 前端重渲染会替换 DOM 节点：按角色+名称在最新快照里唯一匹配后重试一次。 */
  async function relocate(tab, target) {
    if (!target.role || !target.name) return undefined;
    const before = tabs.refCounter;
    await snapshot(tab, cdpFor(tab), { interactive: true, maxChars: 40000 });
    let found;
    for (const info of tab.refs.byRef.values()) {
      if (info.seq <= before) continue;
      if (info.role !== target.role || info.name !== target.name) continue;
      if (found) return undefined;
      found = info;
    }
    return found;
  }

  /** 把引用解析为页面对象 ID；同文档内节点被前端重渲染替换时，按角色+名称自动重定位一次。 */
  async function resolve(tab, ref) {
    const target = tab.refs.byRef.get(ref);
    if (!target) {
      throw agentError('ref_not_found', '引用 ' + ref + ' 不存在（页面可能已导航），请重新 snapshot 获取新引用');
    }
    try {
      const { object } = await cdpFor(tab)('DOM.resolveNode', { backendNodeId: target.backendId });
      if (!object?.objectId) throw new Error();
      return object.objectId;
    } catch {
      const moved = await relocate(tab, target).catch(() => undefined);
      if (moved) {
        const { object } = await cdpFor(tab)('DOM.resolveNode', { backendNodeId: moved.backendId });
        if (object?.objectId) return object.objectId;
      }
      throw agentError('ref_stale', '元素 ' + ref + ' 已从页面移除，请重新 snapshot');
    }
  }

  /** 把 ref 或 CSS 选择器解析为页面对象 ID（selector 优先取最后一个可见匹配，用于关闭图标等无 AX 节点元素）。 */
  async function resolveTarget(tab, ref, selector) {
    if (ref) return resolve(tab, ref);
    if (!selector) throw agentError('missing_target', '请提供 ref 或 selector');
    const res = await cdpFor(tab)('Runtime.evaluate', {
      expression: `(() => {
        const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const vis = list.filter((e) => e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : e.getClientRects().length > 0);
        return vis.length ? vis[vis.length - 1] : list[0] || null;
      })()`
    });
    const objectId = res?.result?.objectId;
    if (!objectId) throw agentError('selector_not_found', '页面上未找到匹配选择器 ' + selector + ' 的元素');
    return objectId;
  }

  async function callOn(tab, objectId, fn, args = [], { byValue = true, timeout = 15000 } = {}) {
    const reply = await cdpFor(tab)('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => (value && value.objectId ? { objectId: value.objectId } : { value })),
      awaitPromise: true,
      returnByValue: byValue,
      userGesture: true
    }, timeout);
    if (reply.exceptionDetails) {
      const detail = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text;
      const error = agentError('script_error', clipText(detail, 1000));
      error.className = reply.exceptionDetails.exception?.className;
      throw error;
    }
    return byValue ? reply.result.value : reply.result;
  }

  async function documentObject(tab) {
    const { result } = await cdpFor(tab)('Runtime.evaluate', { expression: 'document' });
    return result.objectId;
  }

  async function release(tab, objectId) {
    if (objectId) await cdpFor(tab)('Runtime.releaseObject', { objectId }).catch(() => {});
  }

  function ensureNoDialog(tab) {
    if (tab.dialog) {
      throw agentError('dialog_open', '页面有未处理的 ' + tab.dialog.type + ' 对话框："' + tab.dialog.message + '"，请先调用 dialog 动作处理');
    }
  }

  function modifierMask(list = []) {
    return list.reduce((mask, name) => mask | (MODIFIERS[name] || (name === 'ControlOrMeta' ? (process.platform === 'darwin' ? 4 : 2) : 0)), 0);
  }

  /**
   * 计算点击坐标；失败时给出可读原因。
   * 被遮挡/仍在移动属于瞬时状态（loading 遮罩、弹窗动画），先轮询等待至多 waitMs 再判失败，
   * 避免 "拼命加载中" 这类几秒内自行消失的遮罩把正常元素判为不可点。
   */
  async function pointFor(tab, objectId, ref, { waitMs = 6000 } = {}) {
    const deadline = Date.now() + waitMs;
    let point;
    for (;;) {
      point = await callOn(tab, objectId, scripts.prepareClick);
      if (point?.x !== undefined) return point;
      if (!['covered', 'moving'].includes(point?.error) || Date.now() >= deadline) break;
      await sleep(200);
    }
    const reasons = {
      hidden: '元素不可见（可能被折叠或需要先展开/滚动）',
      disabled: '元素处于禁用状态',
      covered: '元素被其他元素遮挡（已等待 ' + waitMs / 1000 + ' 秒仍未消失）：' + (point?.by || '') + '，可先关闭遮罩/弹窗，或使用 force: true',
      moving: '元素仍在动画移动，可稍后重试',
      offscreen: '元素不在可视区域',
      detached: '元素已从页面移除'
    };
    throw agentError('not_clickable', (ref ? ref + ': ' : '') + (reasons[point?.error] || '无法点击该元素'));
  }

  async function mouseClick(tab, point, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    const cdp = cdpFor(tab);
    hooks.pointer?.(tab, { x: point.x, y: point.y, action: '点击' });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: i, modifiers });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: i, modifiers });
    }
  }

  async function clickObject(tab, objectId, options = {}, ref) {
    let point;
    try {
      point = await pointFor(tab, objectId, ref);
    } catch (error) {
      if (!options.force) throw error;
      await callOn(tab, objectId, 'function(){ (this.nodeType===1?this:this.parentElement).click(); }');
      return { forced: true, bypassedOcclusion: error.agent?.hint || String(error.message || error) };
    }
    await mouseClick(tab, point, {
      button: options.button || 'left',
      clickCount: options.doubleClick ? 2 : 1,
      modifiers: modifierMask(options.modifiers)
    });
    return {};
  }

  /** 解析 "Control+Shift+A" 并派发键盘事件。 */
  async function pressKey(tab, combo) {
    const cdp = cdpFor(tab);
    const parts = combo.split('+').filter(Boolean);
    let key = parts.pop() || combo;
    if (combo.endsWith('++')) key = '+';
    const modifierNames = parts.map((part) => (part === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : part));
    for (const name of modifierNames) if (!MODIFIERS[name]) throw agentError('invalid_key', '未知修饰键 ' + name);
    const modifiers = modifierMask(modifierNames);
    let code, text, keyCode;
    if (KEYS[key]) {
      [keyCode, text] = KEYS[key];
      code = key === ' ' ? 'Space' : key;
      if (key === 'Space') key = ' ';
    } else if ([...key].length === 1) {
      const upper = key.toUpperCase();
      keyCode = upper.charCodeAt(0);
      code = /[A-Z]/.test(upper) ? 'Key' + upper : /[0-9]/.test(key) ? 'Digit' + key : '';
      text = key;
    } else {
      throw agentError('invalid_key', '不支持的按键 ' + key);
    }
    const editing = modifiers & 6 ? EDIT_COMMANDS[key.toLowerCase()] : undefined;
    if (modifiers & 6) text = undefined;
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await cdp('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, commands: editing ? [editing] : undefined });
    await cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  /**
   * 动作后等待页面稳定：导航加载完成 → 网络空闲 → DOM 静默。整体上限约 8 秒，
   * 超时不报错，只在结果中标记 still_loading，由 Agent 决定是否 wait_for。
   */
  async function settle(tab, { navigation = false } = {}) {
    const start = Date.now();
    await sleep(navigation ? 120 : 80);
    if (tab.contents.isDestroyed() || tab.dialog) return;
    const loadLimit = navigation ? 15000 : 8000;
    while (tab.contents.isLoading() && Date.now() - start < loadLimit) await sleep(80);
    const idleStart = Date.now();
    const quietNetMs = navigation ? 300 : 120;
    while (Date.now() - idleStart < 3000) {
      const pending = [...tab.inflight.values()].filter((time) => Date.now() - time < 5000).length;
      if (pending === 0 && Date.now() - tab.lastNetwork > quietNetMs) break;
      await sleep(60);
    }
    if (tab.dialog || tab.contents.isDestroyed()) return;
    try {
      const doc = await documentObject(tab);
      await callOn(tab, doc, scripts.waitDomQuiet, [navigation ? 180 : 100, navigation ? 1200 : 800], { timeout: 2500 });
      await release(tab, doc);
    } catch {}
    return tab.contents.isLoading() ? 'still_loading' : undefined;
  }

  async function waitNavigation(tab, start, timeout = 20000) {
    const contents = tab.contents;
    return new Promise((resolvePromise) => {
      let timer;
      const done = (result) => {
        clearTimeout(timer);
        contents.removeListener('did-finish-load', onFinish);
        contents.removeListener('did-fail-load', onFail);
        resolvePromise(result);
      };
      const onFinish = () => done({ ok: true });
      const onFail = (_e, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) done({ ok: false, error: description });
      };
      contents.on('did-finish-load', onFinish);
      contents.on('did-fail-load', onFail);
      timer = setTimeout(() => done({ ok: true, timeout: true }), timeout);
      Promise.resolve(start()).catch((error) => done({ ok: false, error: String(error?.message || error) }));
    });
  }

  function summary(tab) {
    const list = tabs.list();
    const result = {
      tabId: tab.id,
      url: tab.contents.isDestroyed() ? '' : tab.contents.getURL(),
      title: tab.contents.isDestroyed() ? '' : tab.contents.getTitle()
    };
    if (list.length > 1) result.tabs = list.map((item) => `[tabId=${item.id}]${item.active ? '*' : ''} ${clipText(item.title || item.url, 60)}`);
    if (tab.dialog) result.dialog = tab.dialog;
    return result;
  }

  async function chooseOptionByText(tab, triggerId, text) {
    const doc = await documentObject(tab);
    try {
      const found = await callOn(tab, doc, scripts.findOptionByText, [text, triggerId ? { objectId: triggerId } : null], { byValue: false });
      if (!found?.objectId) return false;
      try {
        await clickObject(tab, found.objectId, {});
      } finally {
        await release(tab, found.objectId);
      }
      return true;
    } finally {
      await release(tab, doc);
    }
  }

  /**
   * 选择选项：原生 select 直接赋值；自定义下拉/级联依次点击：
   * 打开控件 →（可编辑时先输入文字过滤）→ 按文字点击选项；values 多项时按顺序逐级点击，
   * 适配级联选择器与多选。
   */
  async function selectOption(tab, ref, values) {
    const objectId = await resolve(tab, ref);
    try {
      const native = await callOn(tab, objectId, scripts.selectNative, [values]);
      if (native) {
        if (!native.ok) throw agentError(native.reason, native.missing ? '找不到选项 ' + native.missing.join(', ') + '，可选：' + (native.options || []).join(' | ') : '该下拉不支持多选');
        return { selected: native.selected };
      }
      const info = await callOn(tab, objectId, scripts.describeElement);
      const canType = info && ((info.tag === 'input' && !info.readOnly) || info.editable);
      const chosen = [];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (i === 0) {
          await clickObject(tab, objectId, {}, ref);
          await sleep(120);
        }
        if (i === 0 || canType) {
          const focusState = await callOn(tab, objectId, scripts.focusAndClear, [true]).catch(() => null);
          if (focusState?.editable) {
            await pressKey(tab, 'Backspace').catch(() => {});
            await cdpFor(tab)('Input.insertText', { text: value });
          }
        }
        let clicked = false;
        for (let attempt = 0; attempt < 12 && !clicked; attempt++) {
          await sleep(attempt ? 250 : 300);
          clicked = await chooseOptionByText(tab, objectId, value);
        }
        if (!clicked) {
          const doc = await documentObject(tab).catch(() => null);
          const visibleOpts = doc ? await callOn(tab, doc, scripts.listVisibleOptions).catch(() => []) : [];
          if (doc) await release(tab, doc);
          const optHint = visibleOpts && visibleOpts.length ? '，当前可见选项：' + visibleOpts.join(' | ') : '';
          throw agentError('option_not_found', '已打开下拉但找不到可见选项 "' + value + '"' + (chosen.length ? '（已选择：' + chosen.join(' > ') + '）' : '') + optHint);
        }
        chosen.push(value);
        await settle(tab);
      }
      const value = await callOn(tab, objectId, scripts.readValue).catch(() => undefined);
      return { selected: chosen, value };
    } finally {
      await release(tab, objectId);
    }
  }

  async function setChecked(tab, ref, checked) {
    const objectId = await resolve(tab, ref);
    try {
      const before = await callOn(tab, objectId, scripts.describeElement);
      if (before?.checked === checked) return { checked, changed: false };
      await clickObject(tab, objectId, {}, ref);
      await sleep(100);
      const after = await callOn(tab, objectId, scripts.describeElement);
      if (after?.checked !== null && after?.checked !== checked) {
        throw agentError('check_failed', '点击后勾选状态仍为 ' + after?.checked);
      }
      return { checked, changed: true };
    } finally {
      await release(tab, objectId);
    }
  }

  async function typeText(tab, { ref, text, submit, slowly, clear }) {
    const cdp = cdpFor(tab);
    if (ref) {
      const objectId = await resolve(tab, ref);
      try {
        await clickObject(tab, objectId, {}, ref).catch(() => {});
        const state = await callOn(tab, objectId, scripts.focusAndClear, [!!clear]);
        if (!state?.ok) throw agentError('not_focusable', ref + ' 无法获得焦点');
        if (!state?.editable) throw agentError('not_editable', ref + (state.readOnly ? ' 是只读输入框（若为下拉选择器请用 select_option）' : ' 不可输入'));
        if (clear) await pressKey(tab, 'Backspace');
      } finally {
        await release(tab, objectId);
      }
    }
    hooks.pointer?.(tab, { action: 'edit' });
    if (slowly) {
      for (const char of text) {
        if (char === '\n') await pressKey(tab, 'Enter');
        else if (/^[\x20-\x7e]$/.test(char)) await pressKey(tab, char);
        else await cdp('Input.insertText', { text: char });
        await sleep(40);
      }
    } else {
      await cdp('Input.insertText', { text });
    }
    if (submit) await pressKey(tab, 'Enter');
  }

  async function fill(tab, ref, text) {
    const objectId = await resolve(tab, ref);
    try {
      hooks.pointer?.(tab, { action: 'edit' });
      const info = await callOn(tab, objectId, scripts.describeElement);
      if (info?.editable) {
        // 富文本编辑器（Quill/ProseMirror/Slate 等）走真实键盘管线，确保内部模型与 ql-blank 等状态同步。
        await clickObject(tab, objectId, {}, ref).catch(() => {});
        await callOn(tab, objectId, scripts.focusAndClear, [true]);
        await pressKey(tab, 'Backspace');
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (i) await pressKey(tab, 'Enter');
          if (lines[i]) await cdpFor(tab)('Input.insertText', { text: lines[i] });
        }
        await sleep(80);
        const value = await callOn(tab, objectId, scripts.readValue);
        return { value, richText: true };
      }
      const result = await callOn(tab, objectId, scripts.fillElement, [text]);
      if (result.ok) return { value: result.value, invalid: result.invalid };
      if (result.reason === 'not_editable' || result.ok === false && result.value !== undefined) {
        // 回退为真实键盘输入，适配监听 keydown 的自定义控件
        await clickObject(tab, objectId, {}, ref).catch(() => {});
        await callOn(tab, objectId, scripts.focusAndClear, [true]);
        await cdpFor(tab)('Input.insertText', { text });
        const value = await callOn(tab, objectId, scripts.readValue);
        return { value, fallback: 'keyboard' };
      }
      throw agentError('fill_failed', ref + ' 无法填写：' + result.reason + (result.options ? '，可选：' + result.options.join(' | ') : ''));
    } finally {
      await release(tab, objectId);
    }
  }

  async function fillForm(tab, fields) {
    const results = [];
    for (const field of fields) {
      const item = { ref: field.ref };
      try {
        const objectId = await resolve(tab, field.ref);
        const info = await callOn(tab, objectId, scripts.describeElement);
        await release(tab, objectId);
        const value = field.value;
        const isCheck = ['checkbox', 'radio'].includes(info?.type) || ['checkbox', 'radio', 'switch', 'menuitemcheckbox'].includes(info?.role);
        if (isCheck || typeof value === 'boolean') {
          Object.assign(item, await setChecked(tab, field.ref, value === true || value === 'true'));
        } else if (Array.isArray(value) || info?.tag === 'select' || info?.role === 'combobox' && info?.tag !== 'input' || info?.hasPopup === 'listbox') {
          Object.assign(item, await selectOption(tab, field.ref, Array.isArray(value) ? value : [String(value)]));
        } else {
          Object.assign(item, await fill(tab, field.ref, String(value)));
        }
        item.ok = true;
      } catch (error) {
        item.ok = false;
        item.error = error.agent ? error.agent.error : 'failed';
        item.hint = error.agent ? error.agent.hint : String(error.message || error);
      }
      results.push(item);
      await sleep(80);
    }
    return { fields: results, failed: results.filter((item) => !item.ok).length };
  }

  async function scroll(tab, { ref, deltaX = 0, deltaY = 0, to }) {
    const cdp = cdpFor(tab);
    let objectId;
    try {
      if (ref) objectId = await resolve(tab, ref);
      if (to) {
        const target = objectId || (await documentObject(tab));
        const state = await callOn(tab, target, scripts.scrollTo, [to]);
        if (!objectId) await release(tab, target);
        return { scroll: state };
      }
      if (ref && !deltaX && !deltaY) {
        await callOn(tab, objectId, 'function(){ (this.nodeType===1?this:this.parentElement).scrollIntoView({block:"center",behavior:"instant"}); }');
        return {};
      }
      let x, y;
      if (objectId) {
        const box = await callOn(tab, objectId, 'function(){ const r=(this.nodeType===1?this:this.parentElement).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+Math.min(r.height/2,200)}; }');
        x = Math.max(1, box.x);
        y = Math.max(1, box.y);
      } else {
        const [width, height] = tab.view.getBounds ? [tab.view.getBounds().width, tab.view.getBounds().height] : [800, 600];
        x = width / 2;
        y = height / 2;
      }
      hooks.pointer?.(tab, { x, y, action: '滚动' });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
      await sleep(250);
      const doc = await documentObject(tab);
      const state = await callOn(tab, doc, scripts.scrollState);
      await release(tab, doc);
      return { scroll: state };
    } finally {
      await release(tab, objectId);
    }
  }

  async function drag(tab, startRef, endRef) {
    const cdp = cdpFor(tab);
    const startId = await resolve(tab, startRef);
    const endId = await resolve(tab, endRef);
    try {
      const from = await pointFor(tab, startId, startRef);
      let intercepted = null;
      const listener = (_e, method, params) => {
        if (method === 'Input.dragIntercepted') intercepted = params.data;
      };
      tab.contents.debugger.on('message', listener);
      await cdp('Input.setInterceptDrags', { enabled: true }).catch(() => {});
      try {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
        const to = await pointFor(tab, endId, endRef).catch(async () => {
          const box = await callOn(tab, endId, 'function(){const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}}');
          return box;
        });
        for (let i = 1; i <= 10; i++) {
          await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10, button: 'left' });
          await sleep(20);
        }
        if (intercepted) {
          for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await cdp('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data: intercepted });
          }
        }
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      } finally {
        tab.contents.debugger.removeListener('message', listener);
        await cdp('Input.setInterceptDrags', { enabled: false }).catch(() => {});
      }
      return { html5: !!intercepted };
    } finally {
      await release(tab, startId);
      await release(tab, endId);
    }
  }

  async function upload(tab, ref, paths) {
    for (const path of paths) {
      if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw agentError('file_not_found', '本机文件不存在：' + path);
    }
    const objectId = await resolve(tab, ref);
    try {
      const input = await callOn(tab, objectId, scripts.findFileInput, [], { byValue: false });
      if (!input?.objectId) throw agentError('no_file_input', ref + ' 附近没有文件上传控件');
      await cdpFor(tab)('DOM.setFileInputFiles', { files: paths, objectId: input.objectId });
      await release(tab, input.objectId);
      return { uploaded: paths.length };
    } finally {
      await release(tab, objectId);
    }
  }

  async function waitFor(tab, { text, textGone, event, seconds, timeout = 10 }) {
    const since = Date.now() - 3000;
    if (seconds) await sleep(Math.min(seconds, 30) * 1000);
    if (!text && !textGone && !event) return {};
    const deadline = Date.now() + Math.min(timeout, 30) * 1000;
    while (Date.now() < deadline) {
      if (tab.dialog) break;
      const doc = await documentObject(tab).catch(() => null);
      if (doc) {
        if (event === 'idle') {
          // 页面空闲：无可见 loading 遮罩/spinner，且网络请求已停止。
          const busy = await callOn(tab, doc, scripts.pageBusy).catch(() => null);
          await release(tab, doc);
          const pending = [...tab.inflight.values()].filter((time) => Date.now() - time < 5000).length;
          if (busy === null || busy === '') {
            if (pending === 0 && Date.now() - tab.lastNetwork > 300) return { idle: true };
          }
        } else if (event) {
          const events = await callOn(tab, doc, scripts.readTransientEvents, [since]).catch(() => []);
          await release(tab, doc);
          const matched = (events || []).filter((item) => item.kind === event || (event === 'toast' && item.kind === 'status'));
          if (matched.length) return { event: matched[matched.length - 1], events: matched };
        } else {
          const has = await callOn(tab, doc, scripts.pageHasText, [text || textGone]).catch(() => null);
          await release(tab, doc);
          if (text && has) return { found: true };
          if (textGone && has === false) return { gone: true };
        }
      }
      await sleep(150);
    }
    throw agentError('wait_timeout', event === 'idle' ? '等待超时，页面仍有 loading 遮罩或进行中的请求' : event ? '等待超时，未捕获到 ' + event + ' 事件（等待加载结束请用 event: "idle"）' : text ? '等待超时，页面未出现 "' + text + '"' : '等待超时，"' + textGone + '" 仍在页面中');
  }

  async function waitBodies(entries) {
    const pending = entries.map((e) => e.bodyPromise).filter(Boolean);
    if (pending.length) await Promise.race([Promise.allSettled(pending), sleep(600)]);
  }

  async function queryNetwork(tab, { urlPattern, statusMin, method, failedOnly, clear, limit = 30 }) {
    if (clear) {
      tab.network = [];
      tab.networkById.clear();
      return { cleared: true, requests: [] };
    }
    let list = tab.network;
    if (urlPattern) {
      const needle = urlPattern.toLowerCase();
      list = list.filter((item) => item.url.toLowerCase().includes(needle));
    }
    if (method) {
      const m = method.toUpperCase();
      list = list.filter((item) => item.method === m);
    }
    if (statusMin) list = list.filter((item) => (item.status || 0) >= statusMin);
    if (failedOnly) list = list.filter((item) => item.error || (item.status && item.status >= 400));
    const slice = list.slice(-Math.min(Math.max(limit, 1), 100));
    await waitBodies(slice);
    return {
      totalMatched: list.length,
      requests: slice.map(({ requestId, mimeType, canceled, bodyPromise, requestHeaders, responseHeaders, ...rest }) => rest)
    };
  }

  function toHarHeaders(map = {}) {
    return Object.entries(map).map(([name, value]) => ({ name, value: String(value) }));
  }

  async function traceAction(tab, { op = 'summary', path: outPath, limit = 30 }) {
    if (op === 'clear') {
      tab.trace = [];
      tab.network = [];
      tab.networkById.clear();
      return { cleared: true };
    }
    if (op === 'export_har') {
      await waitBodies(tab.network.slice(-50));
      const target = outPath
        ? nodePath.resolve(outPath)
        : nodePath.join(os.tmpdir(), `bore-browser-trace-${Date.now()}.har`);
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      const har = {
        log: {
          version: '1.2',
          creator: { name: '伯仁浏览器', version: '0.2' },
          entries: tab.network.map((item) => ({
            startedDateTime: new Date(item.timestamp).toISOString(),
            time: item.durationMs || 0,
            request: {
              method: item.method,
              url: item.url,
              httpVersion: 'HTTP/1.1',
              headers: toHarHeaders(item.requestHeaders),
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: item.requestBody ? Buffer.byteLength(item.requestBody) : 0,
              ...(item.requestBody ? { postData: { mimeType: 'application/json', text: item.requestBody } } : {})
            },
            response: {
              status: item.status || 0,
              statusText: item.statusText || item.error || '',
              httpVersion: 'HTTP/1.1',
              headers: toHarHeaders(item.responseHeaders),
              cookies: [],
              content: {
                size: item.responseBody ? Buffer.byteLength(item.responseBody) : 0,
                mimeType: item.mimeType || 'application/octet-stream',
                ...(item.responseBody ? { text: item.responseBody } : {})
              },
              redirectURL: '',
              headersSize: -1,
              bodySize: item.responseBody ? Buffer.byteLength(item.responseBody) : 0
            },
            cache: {},
            timings: { send: 0, wait: item.durationMs || 0, receive: 0 }
          }))
        }
      };
      const harText = JSON.stringify(har, null, 2);
      fs.writeFileSync(target, harText, 'utf8');
      const actionsFile = target.replace(/\.har$/i, '') + '-actions.json';
      fs.writeFileSync(actionsFile, JSON.stringify({ exportedAt: new Date().toISOString(), steps: tab.trace }, null, 2), 'utf8');
      return {
        harPath: target,
        actionsPath: actionsFile,
        networkEntries: har.log.entries.length,
        actionSteps: tab.trace.length,
        bytes: Buffer.byteLength(harText)
      };
    }
    return {
      totalSteps: tab.trace.length,
      networkEntries: tab.network.length,
      steps: tab.trace.slice(-Math.min(Math.max(limit, 1), 100))
    };
  }

  async function extract(tab, { ref, format = 'markdown', offset = 0, maxChars = 20000 }) {
    let objectId;
    try {
      objectId = ref ? await resolve(tab, ref) : await documentObject(tab);
      const target = ref ? objectId : (await callOn(tab, objectId, 'function(){return this.body}', [], { byValue: false })).objectId;
      const text = String(await callOn(tab, target, scripts.extractMarkdown, [format], { timeout: 20000 }) || '');
      if (!ref) await release(tab, target);
      const content = text.slice(offset, offset + maxChars);
      return { content, totalChars: text.length, nextOffset: offset + maxChars < text.length ? offset + maxChars : undefined };
    } finally {
      await release(tab, objectId);
    }
  }

  /**
   * 执行任意页面脚本，依次尝试：
   * 1. 单个表达式/函数表达式（函数以 ref 元素为参数调用）；
   * 2. 多语句程序，取最后一个表达式语句的值（与 DevTools 控制台一致，支持顶层 await）；
   * 3. 语句体（含顶层 return）。
   * 旧实现在第 2 类脚本（如 `const a = ...; a.join()`）上直接返回 undefined，导致误判页面无数据。
   */
  async function evaluate(tab, { script, ref }) {
    const cdp = cdpFor(tab);
    const objectId = ref ? await resolve(tab, ref) : await documentObject(tab);
    try {
      const asExpression = 'async function(){ const el = this; const __v = (' + script + '\n); return typeof __v === "function" ? await __v.call(this, el) : await __v; }';
      const asBody = 'async function(){ const el = this;\n' + script + '\n}';
      // 块内只有声明语句时不产生完成值，因此脚本最后一个表达式的值即为结果。
      const asProgram = '{ const el = globalThis.__fastgptEvalTarget;\n' + script + '\n}';
      let value;
      let mode = 'expression';
      try {
        value = await callOn(tab, objectId, asExpression, [], { timeout: 30000 });
      } catch (error) {
        if (error.className !== 'SyntaxError') throw error;
        try {
          mode = 'program';
          await callOn(tab, objectId, 'function(){ globalThis.__fastgptEvalTarget = this; }');
          const reply = await cdp('Runtime.evaluate', {
            expression: asProgram, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true
          }, 30000);
          if (reply.exceptionDetails) {
            const detail = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text;
            const failure = agentError('script_error', clipText(detail, 1000));
            failure.className = reply.exceptionDetails.exception?.className;
            throw failure;
          }
          value = reply.result?.value;
        } catch (programError) {
          // 顶层 return 等只在函数体内合法的写法，回退为语句体执行。
          if (programError.className !== 'SyntaxError') throw programError;
          mode = 'body';
          value = await callOn(tab, objectId, asBody, [], { timeout: 30000 });
        } finally {
          await cdp('Runtime.evaluate', { expression: 'delete globalThis.__fastgptEvalTarget' }).catch(() => {});
        }
      }
      let text = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 1);
      const total = text.length;
      if (total > 40000) text = text.slice(0, 40000);
      const out = { result: text, truncated: total > 40000 ? total : undefined };
      if (value === undefined) {
        out.hint = mode === 'body'
          ? '脚本执行成功但没有返回值：语句体中请用 return 返回结果'
          : '脚本的结果为 undefined（DOM 节点等不可序列化的值也会显示为 {} 或 undefined，请返回字符串/数组/普通对象）';
      }
      return out;
    } finally {
      await release(tab, objectId);
    }
  }

  async function screenshot(tab, { ref, fullPage }) {
    const cdp = cdpFor(tab);
    const params = { format: 'jpeg', quality: 60 };
    if (ref) {
      const objectId = await resolve(tab, ref);
      try {
        const rect = await callOn(tab, objectId, 'function(){ const e=this.nodeType===1?this:this.parentElement; e.scrollIntoView({block:"center",behavior:"instant"}); const r=e.getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}; }');
        if (!rect.width || !rect.height) throw agentError('hidden', ref + ' 不可见');
        params.clip = { ...rect, height: Math.min(rect.height, 4000), scale: 1 };
        params.captureBeyondViewport = true;
      } finally {
        await release(tab, objectId);
      }
    } else if (fullPage) {
      const metrics = await cdp('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      params.clip = { x: 0, y: 0, width: Math.min(size.width, 1600), height: Math.min(size.height, 6000), scale: size.height > 3000 ? 0.6 : 1 };
      params.captureBeyondViewport = true;
    }
    let { data } = await cdp('Page.captureScreenshot', params, 20000);
    for (const quality of [40, 25]) {
      if (data.length <= 700 * 1024) break;
      params.quality = quality;
      if (params.clip) params.clip.scale = (params.clip.scale || 1) * 0.7;
      ({ data } = await cdp('Page.captureScreenshot', params, 20000));
    }
    if (data.length > 760 * 1024) throw agentError('screenshot_too_large', '截图过大，可改用 ref 局部截图');
    return { data };
  }

  async function tabsAction(action) {
    const op = action.op || 'list';
    // tabId 稳定不变；index 会随关闭标签而漂移，仅为兼容保留。
    const pick = () => {
      const tab = action.tabId !== undefined ? tabs.find(action.tabId) : tabs.tabs[action.index];
      if (!tab) throw agentError('tab_not_found', '没有' + (action.tabId !== undefined ? ' tabId=' + action.tabId : '序号为 ' + action.index) + ' 的标签页');
      return tab;
    };
    let opened;
    if (op === 'new') {
      const url = action.url ? webURL(action.url) : undefined;
      if (action.url && !url) throw agentError('invalid_url', '只支持 http/https 网址');
      opened = await tabs.create(url, { activate: action.activate !== false });
      if (url) await waitNavigation(opened, () => {}, 15000);
    } else if (op === 'select') {
      tabs.select(pick().id);
    } else if (op === 'close') {
      await tabs.close(pick().id);
    } else if (op !== 'list') {
      throw agentError('invalid_op', '未知 tabs 操作 ' + op);
    }
    const result = { tabList: tabs.list().map(({ id, ...rest }) => rest) };
    if (opened) {
      result.openedTabId = opened.id;
      result._targetTab = opened;
    }
    return result;
  }

  /** 执行单个动作，返回动作自身的结果字段。 */
  async function execute(action, tab) {
    const name = action.action;
    if (name === 'tabs') return tabsAction(action);
    await tab.ready;
    if (name === 'screenshot' && tab !== tabs.active) {
      // 隐藏的 WebContentsView 不合成画面，截图前先切到前台。
      tabs.select(tab.id);
      await sleep(150);
    }
    if (name === 'dialog') {
      if (!tab.dialog) throw agentError('no_dialog', '当前没有待处理的对话框');
      await cdpFor(tab)('Page.handleJavaScriptDialog', { accept: !!action.accept, promptText: action.promptText });
      tab.dialog = null;
      return { handled: true };
    }
    ensureNoDialog(tab);
    switch (name) {
      case 'navigate': {
        const url = webURL(action.url);
        if (!url) throw agentError('invalid_url', '只支持 http/https 网址');
        const result = await waitNavigation(tab, () => tab.contents.loadURL(url));
        if (!result.ok) throw agentError('navigation_failed', '打开失败：' + result.error);
        return result.timeout ? { loading: true } : {};
      }
      case 'go_back':
      case 'go_forward': {
        const history = tab.contents.navigationHistory;
        const can = name === 'go_back' ? history.canGoBack() : history.canGoForward();
        if (!can) throw agentError('no_history', name === 'go_back' ? '没有可后退的页面' : '没有可前进的页面');
        await waitNavigation(tab, () => (name === 'go_back' ? history.goBack() : history.goForward()), 15000);
        return {};
      }
      case 'reload':
        await waitNavigation(tab, () => tab.contents.reload(), 20000);
        return {};
      case 'snapshot':
        return snapshot(tab, cdpFor(tab), action);
      case 'click': {
        const objectId = await resolveTarget(tab, action.ref, action.selector);
        try {
          return await clickObject(tab, objectId, action, action.ref || action.selector);
        } finally {
          await release(tab, objectId);
        }
      }
      case 'hover': {
        const objectId = await resolveTarget(tab, action.ref, action.selector);
        try {
          const point = await pointFor(tab, objectId, action.ref || action.selector);
          hooks.pointer?.(tab, { x: point.x, y: point.y, action: '悬停' });
          await cdpFor(tab)('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
          return {};
        } finally {
          await release(tab, objectId);
        }
      }
      case 'type':
        await typeText(tab, action);
        return {};
      case 'fill':
        return fill(tab, action.ref, action.text);
      case 'select_option':
        return selectOption(tab, action.ref, action.values);
      case 'check':
        return setChecked(tab, action.ref, action.checked);
      case 'press':
        if (action.ref) {
          const objectId = await resolve(tab, action.ref);
          await callOn(tab, objectId, scripts.focusAndClear, [false]).finally(() => release(tab, objectId));
        }
        await pressKey(tab, action.key);
        return {};
      case 'scroll':
        return scroll(tab, action);
      case 'drag':
        return drag(tab, action.startRef, action.endRef);
      case 'upload_file':
        return upload(tab, action.ref, action.paths);
      case 'fill_form':
        return fillForm(tab, action.fields);
      case 'wait_for':
        return waitFor(tab, action);
      case 'network':
        return queryNetwork(tab, action);
      case 'trace':
        return traceAction(tab, action);
      case 'extract':
        return extract(tab, action);
      case 'evaluate':
        return evaluate(tab, action);
      case 'screenshot':
        return screenshot(tab, action);
      default:
        throw agentError('unknown_action', '未知动作 ' + name);
    }
  }

  // 这些动作需要回报"是否产生了效果"，避免 Agent 分不清已生效还是空操作。
  const EFFECT_ACTIONS = new Set(['click', 'press', 'select_option', 'check', 'fill', 'type', 'fill_form', 'drag', 'dialog', 'hover']);

  async function readMutations(tab) {
    try {
      const reply = await cdpFor(tab)('Runtime.evaluate', { expression: 'window.__fastgptMutations || 0', returnByValue: true }, 3000);
      return typeof reply?.result?.value === 'number' ? reply.result.value : undefined;
    } catch {
      return undefined;
    }
  }

  /** 执行一个动作（或 batch），统一附加页面摘要、自动等待、失败请求与瞬时提示。 */
  async function runOne(action) {
    tabs.openedDuringAction = [];
    const startTab = tabs.active;
    const startedAt = Date.now();
    const acted = action.action === 'tabs' ? tabs.active : targetTab(action);
    const trackEffect = acted && EFFECT_ACTIONS.has(action.action);
    const before = trackEffect
      ? { url: acted.contents.getURL(), mutations: await readMutations(acted), document: acted.document }
      : undefined;
    const result = await execute(action, acted);
    const explicitTab = result?._targetTab;
    if (result) delete result._targetTab;
    // tabs new/select 会改变目标；新窗口打开时跟随到新标签，否则停留在动作所在标签。
    let tab = explicitTab || (action.action === 'tabs' || tabs.openedDuringAction.length ? tabs.active : acted);
    if (MUTATING.has(action.action) && action.action !== 'wait_for' || action.action === 'wait_for' && action.seconds) {
      const waited = await settle(tab, { navigation: ['navigate', 'reload', 'go_back', 'go_forward'].includes(action.action) });
      if (waited) result.loading = true;
      if (!explicitTab && (action.action === 'tabs' || tabs.openedDuringAction.length)) tab = tabs.active;
      if (tab && !tab.contents.isDestroyed()) {
        // 动作期间出现的 4xx/5xx 或网络失败直接回执给 Agent，无需用户手动注入 hook。
        const rawFailed = tab.network
          .filter((item) => item.timestamp >= startedAt - 100 && (item.error || (item.status && item.status >= 400)))
          .slice(-5);
        await waitBodies(rawFailed);
        const failed = rawFailed.map(({ method, url, status, error, responseBody }) => ({
          method, url, status, error,
          responseBody: responseBody ? clipText(responseBody, 1000) : undefined
        }));
        if (failed.length) result.failedRequests = failed;
        // 收集动作期间一闪而过的 toast / alert，避免 1 秒后消失导致误判。
        if (!tab.dialog) {
          const doc = await documentObject(tab).catch(() => null);
          if (doc) {
            const events = await callOn(tab, doc, scripts.readTransientEvents, [startedAt - 100]).catch(() => []);
            await release(tab, doc);
            const clean = (events || []).filter((item) => item.kind !== 'loading');
            if (clean.length) result.uiEvents = clean.slice(-5);
          }
        }
        if (before) result.effect = await describeEffect(tab, before, startedAt, result);
      }
    }
    if (tabs.openedDuringAction.length) {
      result.newTab = '动作打开了新标签页，已自动切换过去';
      tab = tabs.active;
    } else if (startTab !== tabs.active && action.action !== 'tabs') {
      result.tabChanged = true;
    }
    return { result, tab };
  }

  /**
   * 汇总动作产生的可观测效果：导航、XHR/Fetch 请求、DOM 变更、瞬时提示、新标签。
   * 全部为空时标记 none，让 Agent 明确知道"点了但页面没反应"，而不是靠猜。
   */
  async function describeEffect(tab, before, startedAt, result) {
    const effect = {};
    const url = tab.contents.getURL();
    if (url !== before.url) effect.navigated = url;
    else if (tab.document !== before.document) effect.reloaded = true;
    const requests = tab.network.filter((item) => item.timestamp >= startedAt - 100 && ['XHR', 'Fetch', 'Document'].includes(item.type));
    if (requests.length) {
      effect.requests = requests.length;
      effect.recentRequests = requests.slice(-5).map(({ method, url: requestUrl, status, error }) => ({
        method, url: clipText(requestUrl, 160), status: status ?? (error ? undefined : 'pending'), error
      }));
    }
    const after = await readMutations(tab);
    if (before.document === tab.document && typeof before.mutations === 'number' && typeof after === 'number') {
      effect.domChanges = Math.max(0, after - before.mutations);
    }
    const nothing = !effect.navigated && !effect.reloaded && !effect.requests && !effect.domChanges &&
      !result.uiEvents && !tabs.openedDuringAction.length && !tab.dialog;
    if (nothing) {
      effect.none = true;
      effect.hint = '动作后页面无可观测变化（无导航、无请求、无 DOM 变化、无提示），可能未生效或该控件无响应';
    }
    return effect;
  }

  /** 引擎入口：任何失败都转为 {ok:false} 结果，让模型看到原因并自行修正。 */
  async function run(action) {
    const out = {};
    const startedAt = Date.now();
    // 摘要、轨迹与附带快照都落在动作实际作用的标签上，而不是恰好处于前台的标签。
    let actedTab;
    try {
      if (action.action === 'batch') {
        const steps = [];
        for (const step of action.actions) {
          try {
            const { result, tab } = await runOne(step);
            actedTab = tab;
            delete result.data;
            steps.push({ action: step.action, ok: true, ...result });
          } catch (error) {
            steps.push({ action: step.action, ok: false, ...(error.agent || { error: 'failed', hint: String(error.message || error) }) });
            break;
          }
        }
        out.ok = steps.every((step) => step.ok);
        out.steps = steps;
        if (!out.ok) out.hint = '批量动作在第 ' + steps.length + ' 步失败，之前的步骤已生效';
      } else {
        const { result, tab } = await runOne(action);
        actedTab = tab;
        Object.assign(out, { ok: true }, result);
      }
    } catch (error) {
      Object.assign(out, { ok: false }, error.agent || { error: 'failed', hint: clipText(String(error?.message || error), 500) });
    }
    let tab = actedTab && tabs.tabs.includes(actedTab) ? actedTab : undefined;
    if (!tab) {
      try {
        tab = action.action === 'batch' ? tabs.active : targetTab(action);
      } catch {
        tab = tabs.active;
      }
    }
    if (tab && !tab.contents.isDestroyed()) {
      if (action.action !== 'trace') {
        tab.trace.push({
          timestamp: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          action: action.action,
          ref: action.ref,
          selector: action.selector,
          ok: out.ok,
          error: out.error,
          url: tab.contents.getURL(),
          uiEvents: out.uiEvents,
          failedRequests: out.failedRequests
        });
        if (tab.trace.length > 200) tab.trace.shift();
      }
      out.page = summary(tab);
      if (action.snapshot && action.action !== 'snapshot' && !tab.dialog) {
        try {
          const snap = await snapshot(tab, cdpFor(tab), { maxChars: 12000 });
          out.snapshot = snap.content;
          if (snap.nextOffset) out.snapshotNextOffset = snap.nextOffset;
        } catch {}
      }
    }
    return out;
  }

  return { run };
}

function clipText(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

module.exports = { createEngine };
