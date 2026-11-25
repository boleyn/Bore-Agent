// 注入页面执行的函数源码，统一通过 Runtime.callFunctionOn 以元素为 this 调用。
// 这些函数只在页面主世界运行，返回值必须可 JSON 序列化。

/**
 * 滚动到可见区域并做命中检测，返回可点击坐标。
 * 隐藏的原生 checkbox/radio/file 输入框改为点击其 label（常见于 UI 组件库）。
 */
const prepareClick = `async function () {
  let el = this;
  if (!el || !el.isConnected) return { error: 'detached' };
  if (el.nodeType !== 1) el = el.parentElement;
  const visible = (node) => node.checkVisibility ? node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : !!node.getClientRects().length;
  if (!visible(el) && el.labels && el.labels.length) el = el.labels[0];
  if (!visible(el)) {
    const parent = el.closest('label,[role=checkbox],[role=radio],[role=switch]');
    if (parent && visible(parent)) el = parent;
  }
  if (!visible(el)) return { error: 'hidden' };
  if (el.matches(':disabled') || el.closest('[aria-disabled="true"],[inert]')) return { error: 'disabled' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const describe = (node) => {
    if (!node) return '';
    const text = (node.getAttribute('aria-label') || node.innerText || node.value || '').trim().slice(0, 60);
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + (text ? ' "' + text + '"' : '');
  };
  const point = () => {
    const rects = Array.from(el.getClientRects());
    for (const r of rects.length ? rects : [el.getBoundingClientRect()]) {
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      if (left >= right || top >= bottom) continue;
      const candidates = [[(left + right) / 2, (top + bottom) / 2], [left + 3, top + 3], [right - 3, bottom - 3], [left + 3, bottom - 3], [right - 3, top + 3]];
      for (const [x, y] of candidates) {
        const hit = el.getRootNode().elementFromPoint ? el.getRootNode().elementFromPoint(x, y) : document.elementFromPoint(x, y);
        if (hit && (el === hit || el.contains(hit) || hit.contains(el) && hit.closest('label') === el.closest('label'))) return { x, y };
      }
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return { covered: describe(hit) };
    }
    return { error: 'offscreen' };
  };
  const raf = () => new Promise((r) => { const t = setTimeout(r, 40); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  await raf();
  const a = point();
  if (!a.x) return a.covered ? { error: 'covered', by: a.covered } : a;
  await raf();
  const b = point();
  if (!b.x) return b.covered ? { error: 'covered', by: b.covered } : b;
  if (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2) return { error: 'moving' };
  // 坐标相对于所在 frame，需要加上 iframe 偏移，转换到顶层视口。
  let x = b.x, y = b.y, win = el.ownerDocument.defaultView;
  try {
    while (win && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      const style = win.frameElement.ownerDocument.defaultView.getComputedStyle(win.frameElement);
      x += fr.left + parseFloat(style.borderLeftWidth || 0) + parseFloat(style.paddingLeft || 0);
      y += fr.top + parseFloat(style.borderTopWidth || 0) + parseFloat(style.paddingTop || 0);
      win = win.parent;
    }
  } catch (_) {}
  return { x, y };
}`;

/** 元素基本信息，用于 fill_form 判断控件类型。 */
const describeElement = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const selectWrap = el.closest && el.closest('.el-select,.el-cascader,.el-autocomplete,.ant-select,.ant-cascader,.ivu-select,.arco-select,.n-select,.t-select,[role=combobox]');
  const root = selectWrap || el;
  const editableInner = root.querySelector && root.querySelector('input:not([type=hidden]):not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled])');
  const anyInner = el.matches('input,textarea,select') ? el : (root.querySelector && root.querySelector('input:not([type=hidden]),textarea,select'));
  const target = editableInner || anyInner || el;
  const role = el.getAttribute('role') || target.getAttribute('role') || (selectWrap && selectWrap.getAttribute('role')) || '';
  const hasPopup = el.getAttribute('aria-haspopup') || target.getAttribute('aria-haspopup') || (selectWrap && selectWrap.getAttribute('aria-haspopup')) || '';
  const ariaReadOnly = el.getAttribute('aria-readonly') === 'true' || target.getAttribute('aria-readonly') === 'true';
  const ariaAuto = el.getAttribute('aria-autocomplete') || target.getAttribute('aria-autocomplete') || '';
  const isSelectWidget = !!selectWrap || role === 'combobox' || hasPopup === 'listbox' || !!ariaAuto;
  let selectExpanded = false;
  if (selectWrap) {
    selectExpanded = selectWrap.getAttribute('aria-expanded') === 'true' ||
      target.getAttribute('aria-expanded') === 'true' ||
      selectWrap.classList.contains('ant-select-open') ||
      selectWrap.classList.contains('ivu-select-visible') ||
      selectWrap.classList.contains('arco-select-popup-shown') ||
      !!(selectWrap.querySelector && selectWrap.querySelector('.el-select__caret.is-reverse,.is-focus'));
  }
  return {
    tag: target.tagName.toLowerCase(),
    hostTag: el.tagName.toLowerCase(),
    type: (target.type || '').toLowerCase(),
    role,
    editable: el.isContentEditable || target.isContentEditable,
    multiple: !!target.multiple,
    hasPopup,
    isSelectWidget,
    selectExpanded,
    readOnly: !!target.readOnly || ariaReadOnly,
    checked: typeof target.checked === 'boolean' && (target.type === 'checkbox' || target.type === 'radio') ? target.checked :
      (el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'false' ? false : null)
  };
}`;

/**
 * 写入普通表单控件或富文本编辑器。普通控件通过原生 setter + input/change 事件，
 * 兼容 React/Vue 受控组件；富文本通过 execCommand 事务写入，支持多行中文。
 */
const fillElement = `async function (text) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const frame = () => new Promise((r) => { const t = setTimeout(r, 40); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
  let editor = el.isContentEditable ? el : el.querySelector && el.querySelector('[contenteditable=""],[contenteditable="true"]');
  if (editor) {
    while (editor.parentElement && editor.parentElement.isContentEditable) editor = editor.parentElement;
    editor.focus();
    const doc = editor.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(editor);
    const sel = doc.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const expected = text.replace(/\\r\\n?/g, '\\n');
    if (!range.collapsed) doc.execCommand('delete');
    const lines = expected.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) doc.execCommand('insertLineBreak');
      if (lines[i]) doc.execCommand('insertText', false, lines[i]);
    }
    await frame();
    const actual = editor.innerText.replace(/\\n+$/, '');
    return { ok: actual.replace(/\\s+/g, '') === expected.replace(/\\s+/g, ''), value: actual.slice(0, 500) };
  }
  let target = el;
  if (!target.matches('input,textarea,select')) {
    const inner = target.querySelector && target.querySelector('input:not([type=hidden]),textarea,select');
    if (!inner) return { ok: false, reason: 'not_editable' };
    target = inner;
  }
  if (target.disabled) return { ok: false, reason: 'disabled' };
  if (target.readOnly) return { ok: false, reason: 'readonly' };
  if (target.tagName === 'INPUT' && ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(target.type)) return { ok: false, reason: 'use_check_or_upload' };
  target.focus();
  if (target.tagName === 'SELECT') {
    const opts = Array.from(target.options).filter((o) => !o.disabled && (o.label.trim() === text.trim() || o.value === text));
    const fuzzy = opts.length ? opts : Array.from(target.options).filter((o) => !o.disabled && o.label.includes(text));
    if (fuzzy.length < 1) return { ok: false, reason: 'option_not_found', options: Array.from(target.options).slice(0, 50).map((o) => o.label) };
    target.value = fuzzy[0].value;
  } else {
    const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(target, '');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(target, text);
  }
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await frame();
  const value = target.tagName === 'SELECT' ? (target.selectedOptions[0] ? target.selectedOptions[0].label : '') : target.value;
  const ok = target.tagName === 'SELECT' ? true : target.value === text;
  return { ok, value: target.type === 'password' ? '***' : String(value).slice(0, 500), invalid: target.validity && !target.validity.valid ? target.validationMessage : undefined };
}`;

/** 原生 select 按选项文字或值选择（支持多选）。 */
const selectNative = `function (values) {
  const el = this;
  if (!el || el.tagName !== 'SELECT') return null;
  const chosen = [];
  const missing = [];
  for (const v of values) {
    const opt = Array.from(el.options).find((o) => !o.disabled && (o.label.trim() === v.trim() || o.value === v)) ||
      Array.from(el.options).find((o) => !o.disabled && o.label.includes(v));
    if (opt) chosen.push(opt); else missing.push(v);
  }
  if (missing.length) return { ok: false, reason: 'option_not_found', missing, options: Array.from(el.options).slice(0, 80).map((o) => o.label) };
  if (!el.multiple && chosen.length > 1) return { ok: false, reason: 'not_multiple' };
  for (const o of el.options) o.selected = chosen.includes(o);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, selected: chosen.map((o) => o.label) };
}`;

/**
 * 在可见元素中按文字查找下拉选项，优先后插入的弹层（组件库下拉通常挂在 body 末尾）。
 * this 为触发的控件，结果排除控件自身。
 */
const findOptionByText = `function (text, exclude) {
  const want = text.trim();
  const wantLower = want.toLowerCase();
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const docs = [document];
  for (const f of document.querySelectorAll('iframe,frame')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (_) {} }
  const visible = (n) => (n.checkVisibility ? n.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : n.getClientRects().length) && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0;
  const roleSel = '[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],[role=gridcell],option,li,dd,td,[class*=option],[class*=item],[class*=node]';
  const popupSel = '[role=listbox],[role=menu],[role=tree],.el-select-dropdown,.el-popper,.el-cascader__dropdown,.el-autocomplete-suggestion,.ant-select-dropdown,[class*=dropdown],[class*=popper],[class*=popup],[class*=cascader],[class*=picker]';
  const navSel = 'nav,[role=navigation],[role=menubar],.el-menu,.ant-menu,.sidebar,.side-menu';
  const maxLen = Math.max(want.length * 6 + 60, 120);
  let best = null, bestScore = -1;
  for (const doc of docs) {
    const all = doc.querySelectorAll(roleSel + ',span,div,a,label');
    let index = 0;
    for (const n of all) {
      index++;
      if (exclude && (exclude === n || exclude.contains(n))) continue;
      const inPopup = !!n.closest(popupSel);
      if (!inPopup && n.closest(navSel)) continue;
      const t = norm(n.innerText);
      if (!t || t.length > maxLen) continue;
      const tLower = t.toLowerCase();
      const exact = t === want;
      const exactCI = !exact && tLower === wantLower;
      const sub = !exact && !exactCI && t.includes(want);
      const subCI = !exact && !exactCI && !sub && tLower.includes(wantLower);
      if (!exact && !exactCI && !sub && !subCI) continue;
      if (!visible(n)) continue;
      let score = (exact ? 1000 : exactCI ? 900 : sub ? 350 : 300) + index / all.length * 100;
      if (n.matches(roleSel)) score += 200;
      if (inPopup) score += 500;
      if (n.closest('.el-select-dropdown__item,.ant-select-item-option,[role=option]')) score += 200;
      score += Math.min(n.querySelectorAll('*').length === 0 ? 20 : 0, 20);
      if (score > bestScore) { best = n; bestScore = score; }
    }
  }
  return best;
}`;

/** DOM 转 Markdown，跳过隐藏节点，展开同源 iframe，表格输出为 Markdown 表格。 */
const extractMarkdown = `function (format) {
  const root = this && this.nodeType ? this : document.body;
  if (format === 'text') return (root.innerText || root.textContent || '').replace(/\\n{3,}/g, '\\n\\n');
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'HEAD', 'META', 'LINK']);
  const visible = (n) => !n.checkVisibility || n.checkVisibility({ checkVisibilityCSS: true });
  const abs = (h) => { try { return new URL(h, document.baseURI).href; } catch (_) { return h; } };
  if (format === 'links') {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href]')) {
      if (!visible(a)) continue;
      const t = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const h = abs(a.getAttribute('href'));
      if (!t || h.startsWith('javascript:') || seen.has(t + h)) continue;
      seen.add(t + h);
      out.push('- [' + t.slice(0, 200) + '](' + h + ')');
    }
    return out.join('\\n');
  }
  const inline = (s) => s.replace(/\\s+/g, ' ');
  // 单元格只排除 display:none；组件库冻结列在主表中以 visibility:hidden（is-hidden）保留文字，不能丢。
  const displayed = (n) => !n.checkVisibility || n.checkVisibility();
  const rawCell = (c) => inline(walk(c, true)).trim();
  const SPLIT = '.el-table,.ant-table,.vxe-table,.ivu-table,.arco-table,.n-data-table,.t-table';
  const FIXED = '.el-table__fixed,.el-table__fixed-right,.el-table__fixed-left,.vxe-table--fixed-left-wrapper,.vxe-table--fixed-right-wrapper,.ivu-table-fixed,.ivu-table-fixed-right,.ant-table-fixed-left,.ant-table-fixed-right';
  const ROLE_CELLS = '[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]';
  const cellDisplayed = (n, ignoreCollapse) => ignoreCollapse ? getComputedStyle(n).display !== 'none' : displayed(n);
  const cellsOf = (r, ignoreCollapse) => Array.from(r.cells || r.querySelectorAll(ROLE_CELLS)).filter((c) => cellDisplayed(c, ignoreCollapse) && !c.classList.contains('gutter'));
  const isMeasureRow = (r) => r.getAttribute('aria-hidden') === 'true' || r.classList.contains('ant-table-measure-row');
  /**
   * 按 rowspan/colspan 展开为规则矩阵，合并单元格的值回填到它覆盖的每个格子（行头因此能对齐到每一行）。
   * ignoreCollapse=true 用于组件库表体被折叠（.el-table__body-wrapper display:none）的场景：
   * 只跳过行自身 display:none（如 "隐藏子指标" 过滤掉的子行），仍完整抽取已渲染的汇总数据行。
   */
  function expand(rows, ignoreCollapse = false) {
    const clean = rows.filter((r) => !isMeasureRow(r) && (ignoreCollapse ? getComputedStyle(r).display !== 'none' : displayed(r)));
    const grid = [];
    clean.forEach((r, ri) => {
      grid[ri] = grid[ri] || [];
      let ci = 0;
      for (const c of cellsOf(r, ignoreCollapse)) {
        while (grid[ri][ci] !== undefined) ci++;
        const rs = Math.max(1, Math.min(parseInt(c.rowSpan || c.getAttribute('aria-rowspan'), 10) || 1, clean.length - ri));
        const cs = Math.max(1, Math.min(parseInt(c.colSpan || c.getAttribute('aria-colspan'), 10) || 1, 200));
        const text = inline(walk(c, true, ignoreCollapse)).trim();
        for (let y = 0; y < rs; y++) {
          const row = (grid[ri + y] = grid[ri + y] || []);
          for (let x = 0; x < cs; x++) row[ci + x] = text;
        }
        ci += cs;
      }
    });
    return grid.slice(0, clean.length).map((r) => Array.from(r, (v) => v ?? ''));
  }
  const isHeaderRow = (r) => !!r.closest('thead') || (cellsOf(r).length > 0 && cellsOf(r).every((c) => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader'));
  const hConcat = (left, right) => {
    const n = Math.max(left.length, right.length);
    const lw = Math.max(0, ...left.map((r) => r.length));
    return Array.from({ length: n }, (_, i) => [
      ...Array.from({ length: lw }, (_, j) => (left[i] && left[i][j]) || ''),
      ...((right[i]) || [])
    ]);
  };
  function grid(box) {
    if (stitchedByEl.has(box)) return stitchedByEl.get(box);
    const { head, body } = rawGrid(box);
    return finish(head, body);
  }
  function finish(head, body) {
    const width = Math.max(0, ...head.map((r) => r.length), ...body.map((r) => r.length));
    const columns = Array.from({ length: width }, (_, i) => {
      const parts = [];
      for (const r of head) { const v = r[i] || ''; if (v && parts[parts.length - 1] !== v) parts.push(v); }
      return parts.join(' / ');
    });
    return { columns, rows: body.filter((r) => r.some((v) => v)).map((r) => Array.from({ length: width }, (_, i) => r[i] || '')) };
  }
  function table(t) {
    if (skippedEls.has(t)) return '';
    const { columns, rows } = grid(t);
    if (!columns.length) return '';
    const esc = (v) => v.replace(/\\|/g, '\\\\|');
    const header = columns.some((c) => c) ? columns : columns.map((_, i) => '列' + (i + 1));
    const line = (r) => '| ' + r.map(esc).join(' | ') + ' |';
    return '\\n\\n' + [line(header), '|' + ' --- |'.repeat(header.length), ...rows.map(line)].join('\\n') + '\\n\\n';
  }
  const TABLE_SEL = 'table,[role=table],[role=grid],[role=treegrid],' + SPLIT;
  /**
   * 合并自定义拆分表（非标准组件库）：
   * 1. 上下拆分的 "仅表头表(T6) + 仅数据表(T7)"（列数相同）；
   * 2. 左右并排的 "左侧冻结科目表 + 右侧月份数据表"（行数相同且列值不重复）。
   */
  function stitchSplitTables(items) {
    const raw = items.map(({ el, head, body, collapsed }) => ({ el, head, body, collapsed }));
    const merged = [];
    const consumed = new Set();
    for (let i = 0; i < raw.length; i++) {
      const cur = raw[i];
      const next = raw[i + 1];
      if (next && cur.head.length > 0 && cur.body.length === 0 && next.head.length === 0 && next.body.length > 0) {
        const hw = Math.max(0, ...cur.head.map((r) => r.length));
        const bw = Math.max(0, ...next.body.map((r) => r.length));
        const sameParent = cur.el.parentElement && next.el.parentElement &&
          (cur.el.parentElement === next.el.parentElement || cur.el.parentElement.parentElement === next.el.parentElement.parentElement);
        if (sameParent && hw > 0 && hw === bw) {
          consumed.add(cur.el);
          // 保留外层容器高度/顶部位置，便于后续与左侧冻结列按同行容器对齐。
          const anchor = cur.el.parentElement === next.el.parentElement ? cur.el.parentElement : next.el;
          merged.push({ el: next.el, anchor, head: cur.head, body: next.body });
          i++;
          continue;
        }
      }
      merged.push({ ...cur, anchor: cur.el });
    }
    const sharedBox = (a, b) => {
      if (!a || !b) return false;
      const chain = new Set();
      for (let n = a.parentElement, d = 0; n && n !== document.body && d < 4; n = n.parentElement, d++) chain.add(n);
      for (let n = b.parentElement, d = 0; n && n !== document.body && d < 4; n = n.parentElement, d++) if (chain.has(n)) return true;
      return false;
    };
    const out = [];
    for (let i = 0; i < merged.length; i++) {
      const cur = merged[i];
      const next = merged[i + 1];
      if (next && cur.body.length > 0 && cur.body.length === next.body.length && cur.head.length === next.head.length) {
        const sameBox = sharedBox(cur.anchor || cur.el, next.anchor || next.el);
        const r1 = (cur.anchor || cur.el).getBoundingClientRect ? (cur.anchor || cur.el).getBoundingClientRect() : null;
        const r2 = (next.anchor || next.el).getBoundingClientRect ? (next.anchor || next.el).getBoundingClientRect() : null;
        const sideBySide = !r1 || !r2 || (r1.width === 0 && r2.width === 0) || (Math.abs(r1.top - r2.top) < 64 && r2.left >= r1.left - 4);
        const duplicate = cur.body.every((fr, ri) => fr.every((val, ci) => !val || (next.body[ri] && next.body[ri][ci] === val)));
        if (sameBox && sideBySide && !duplicate) {
          consumed.add(next.el);
          out.push({ el: cur.el, anchor: cur.anchor, head: hConcat(cur.head, next.head), body: hConcat(cur.body, next.body) });
          i++;
          continue;
        }
      }
      out.push(cur);
    }
    return { list: out, consumed };
  }
  function rawGrid(box) {
    let headRows = [], bodyRows = [];
    if (box.matches(SPLIT)) {
      const innerTables = Array.from(box.querySelectorAll('table')).filter((t) => {
        if (t.closest(SPLIT) !== box) return false;
        const outer = t.parentElement && t.parentElement.closest('td,th');
        return !(outer && box.contains(outer));
      });
      const main = innerTables.filter((t) => !t.closest(FIXED));
      const fixedLeft = innerTables.filter((t) => t.closest('.el-table__fixed,.el-table__fixed-left,.vxe-table--fixed-left-wrapper,.ivu-table-fixed,.ant-table-fixed-left'));
      for (const t of main) for (const r of Array.from(t.rows)) (r.closest('thead') ? headRows : bodyRows).push(r);
      let head = expand(headRows);
      let body = expand(bodyRows.slice(0, 2000));
      let collapsed = false;
      // 组件库外层可见但表体默认折叠（如 EBOSS 月度明细初始 body-wrapper display:none）时，直接穿透读取已渲染的数据行。
      if (body.length === 0 && bodyRows.length > 0) {
        body = expand(bodyRows.slice(0, 2000), true);
        collapsed = body.length > 0;
      }
      if (fixedLeft.length) {
        const fh = [], fb = [];
        for (const t of fixedLeft) for (const r of Array.from(t.rows)) (r.closest('thead') ? fh : fb).push(r);
        const fHead = expand(fh), fBody = expand(fb.slice(0, 2000), collapsed);
        const fWidth = Math.max(0, ...fHead.map((r) => r.length), ...fBody.map((r) => r.length));
        if (fWidth > 0 && fBody.length === body.length) {
          const overlap = fBody.every((fr, ri) => fr.every((val, ci) => !val || (body[ri] && body[ri][ci] === val)));
          if (!overlap) {
            head = hConcat(fHead, head);
            body = hConcat(fBody, body);
          } else {
            fHead.forEach((fr, ri) => fr.forEach((val, ci) => { if (val && head[ri] && !head[ri][ci]) head[ri][ci] = val; }));
            fBody.forEach((fr, ri) => fr.forEach((val, ci) => { if (val && body[ri] && !body[ri][ci]) body[ri][ci] = val; }));
          }
        }
      }
      return { head, body, collapsed };
    }
    if (box.tagName === 'TABLE') {
      for (const r of Array.from(box.rows)) (isHeaderRow(r) && !bodyRows.length ? headRows : bodyRows).push(r);
      return { head: expand(headRows), body: expand(bodyRows.slice(0, 2000)) };
    }
    const all = Array.from(box.querySelectorAll('[role=row]')).filter(displayed);
    const indexed = all.some((r) => r.hasAttribute('aria-rowindex'));
    if (indexed) {
      const byIndex = new Map();
      for (const r of all) {
        const key = r.getAttribute('aria-rowindex') || '';
        if (!byIndex.has(key)) byIndex.set(key, []);
        byIndex.get(key).push(...cellsOf(r));
      }
      const order = Array.from(byIndex.keys()).sort((a, b) => (+a || 0) - (+b || 0));
      const matrix = order.map((key) => byIndex.get(key)
        .sort((a, b) => (+a.getAttribute('aria-colindex') || 0) - (+b.getAttribute('aria-colindex') || 0)));
      const head = [], body = [];
      for (const cells of matrix) {
        const values = cells.map(rawCell);
        (cells.length && cells.every((c) => c.getAttribute('role') === 'columnheader') && !body.length ? head : body).push(values);
      }
      return { head, body };
    }
    for (const r of all) (isHeaderRow(r) && !bodyRows.length ? headRows : bodyRows).push(r);
    return { head: expand(headRows), body: expand(bodyRows.slice(0, 2000)) };
  }
  const stitchedByEl = new Map();
  const topTables = (root.matches && root.matches(TABLE_SEL) ? [root] : Array.from(root.querySelectorAll(TABLE_SEL)))
    .filter((t) => visible(t) && !(t !== root && t.parentElement && t.parentElement.closest(TABLE_SEL) && root.contains(t.parentElement.closest(TABLE_SEL))));
  const parsedTables = topTables.map((el) => ({ el, ...rawGrid(el) }));
  const { list: stitched, consumed: skippedEls } = stitchSplitTables(parsedTables);
  for (const item of stitched) stitchedByEl.set(item.el, finish(item.head, item.body));
    if (format === 'tables') {
      // 结构化输出：每张表 { columns, rows, editable?, collapsed? }，同时返回所有可编辑单元格的 {row, col, rowHeader, column, value, ref?} 概览。
      return JSON.stringify(stitched.slice(0, 20).map((item, index) => {
        const { columns, rows } = finish(item.head, item.body);
        const editable = [];
        const srcRows = item.el.matches && item.el.matches(SPLIT)
          ? Array.from(item.el.querySelectorAll('.el-table__body-wrapper tbody tr,tbody tr')).filter((r) => !r.closest(FIXED) && getComputedStyle(r).display !== 'none')
          : Array.from(item.el.rows || []).filter((r) => !isHeaderRow(r) && getComputedStyle(r).display !== 'none');
        srcRows.forEach((tr, ri) => {
          Array.from(tr.cells || []).forEach((td, ci) => {
            const inp = td.querySelector && td.querySelector('input:not([type=hidden]):not([disabled]):not([readonly]),textarea:not([disabled]):not([readonly]),select:not([disabled])');
            if (inp) {
              editable.push({
                row: ri,
                col: ci,
                label: (rows[ri] || []).slice(0, 2).filter(Boolean).join(' / '),
                column: columns[ci] || '',
                ariaLabel: inp.getAttribute('aria-label') || '',
                value: inp.value ?? ''
              });
            }
          });
        });
        return {
          index,
          ...(item.collapsed ? { collapsed: true } : {}),
          columns,
          rows,
          ...(editable.length
            ? {
                editableCount: editable.length,
                editableRows: [...new Set(editable.map((e) => e.label).filter(Boolean))].slice(0, 50),
                editableColumns: [...new Set(editable.map((e) => e.column).filter(Boolean))],
                editableSample: editable.slice(0, 30)
              }
            : {})
        };
      }));
    }
  function walk(node, flat, ignoreCollapse = false) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 || skip.has(node.tagName.toUpperCase())) return '';
    if (ignoreCollapse ? getComputedStyle(node).display === 'none' : (flat ? !displayed(node) : !visible(node))) return '';
    const tag = node.tagName;
    if (tag === 'IFRAME' || tag === 'FRAME') { try { return node.contentDocument ? walk(node.contentDocument.body, flat, ignoreCollapse) : ''; } catch (_) { return ''; } }
    if (tag === 'INPUT') {
      if (node.type === 'hidden') return '';
      if (node.type === 'checkbox' || node.type === 'radio') return node.checked ? '[x] ' : '[ ] ';
      if (node.type === 'password') return '[input:***]';
      return node.value ? '[input: ' + node.value + ']' : (node.placeholder ? '[input placeholder: ' + node.placeholder + ']' : '[input]');
    }
    if (tag === 'TEXTAREA') return '[textarea: ' + node.value.slice(0, 2000) + ']';
    if (tag === 'SELECT') return '[select: ' + Array.from(node.selectedOptions).map((o) => o.label).join(', ') + ']';
    if (tag === 'IMG') return node.alt ? '![' + node.alt + ']' : '';
    if (tag === 'BR') return flat ? ' ' : '\\n';
    if (!flat && (tag === 'TABLE' || ['table', 'grid', 'treegrid'].includes(node.getAttribute('role')) || node.matches(SPLIT))) return table(node);
    let inner = '';
    for (const child of node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes) inner += walk(child, flat, ignoreCollapse);
    if (flat) return inner;
    const text = inner.trim();
    if (!text) return '';
    if (/^H[1-6]$/.test(tag)) return '\\n\\n' + '#'.repeat(+tag[1]) + ' ' + inline(text) + '\\n\\n';
    if (tag === 'A' && node.getAttribute('href') && !node.getAttribute('href').startsWith('javascript:')) return '[' + inline(text) + '](' + abs(node.getAttribute('href')) + ')';
    if (tag === 'LI') return '\\n- ' + text.replace(/\\n+/g, ' ') + '\\n';
    if (tag === 'STRONG' || tag === 'B') return '**' + text + '**';
    if (tag === 'PRE') return '\\n\\n\`\`\`\\n' + node.innerText + '\\n\`\`\`\\n\\n';
    if (tag === 'BUTTON') return ' [button: ' + inline(text) + '] ';
    const display = getComputedStyle(node).display;
    if (display && !display.startsWith('inline')) return '\\n' + inner + '\\n';
    return inner;
  }
  return walk(root, false).replace(/[ \\t]+\\n/g, '\\n').replace(/\\n[ \\t]+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]{2,}/g, ' ').trim();
}`;

/** 页面（含同源 iframe）是否包含文字。 */
const pageHasText = `function (text) {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe,frame')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (_) {} }
  return docs.some((d) => d.body && d.body.innerText.includes(text));
}`;

/** 等待 DOM 静默，组件库异步渲染、虚拟列表都会在此稳定。 */
const waitDomQuiet = `function (quietMs, maxMs) {
  return new Promise((resolve) => {
    let timer;
    const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(true); };
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}`;

/** 滚动元素（或最近的可滚动祖先、或页面）到顶部/底部，返回滚动位置。 */
const scrollTo = `function (to) {
  let el = this && this.nodeType === 1 ? this : document.scrollingElement;
  const scrollable = (n) => n && (n.scrollHeight > n.clientHeight + 2) && /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY);
  if (el !== document.scrollingElement) { let n = el; while (n && n !== document.body && !scrollable(n)) n = n.parentElement; el = n && n !== document.body ? n : document.scrollingElement; }
  if (to === 'top') el.scrollTop = 0;
  if (to === 'bottom') el.scrollTop = el.scrollHeight;
  return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}`;

/** 读取页面滚动位置，帮助 Agent 判断是否已到底。 */
const scrollState = `function () {
  const el = document.scrollingElement || document.documentElement;
  return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4 };
}`;

/** 列出当前可见下拉弹层中的候选选项文本，供找不到目标时提示。 */
const listVisibleOptions = `function () {
  const popupSel = '[role=listbox],[role=menu],.el-select-dropdown,.el-popper,.el-cascader__dropdown,.el-autocomplete-suggestion,.ant-select-dropdown';
  const visible = (n) => (n.checkVisibility ? n.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : n.getClientRects().length) && n.getBoundingClientRect().width > 0;
  const out = [];
  const seen = new Set();
  for (const pop of document.querySelectorAll(popupSel)) {
    if (!visible(pop)) continue;
    for (const item of pop.querySelectorAll('[role=option],[role=menuitem],li,.el-select-dropdown__item,.ant-select-item-option')) {
      if (!visible(item)) continue;
      const t = (item.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t.slice(0, 80));
        if (out.length >= 20) return out;
      }
    }
  }
  return out;
}`;

/** 输入前清空内容并聚焦（支持 input/textarea/contenteditable）。 */
const focusAndClear = `function (clear) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  let target = el;
  if (!target.matches('input,textarea,select,[contenteditable]') && !target.isContentEditable) {
    target = el.querySelector('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable="true"]') || el;
  }
  target.focus();
  const active = target.ownerDocument.activeElement;
  const editable = active && (active.isContentEditable || (active.matches && active.matches('input:not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled])')));
  if (clear && editable) {
    if (active.select && 'value' in active) active.select();
    else if (active.isContentEditable) { const r = document.createRange(); r.selectNodeContents(active); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  const focused = active === target || target.contains(active);
  return { ok: focused, readOnly: !!target.readOnly, editable: !!editable };
}`;

/** 读取控件当前值，供 fill/type 后回显核对。 */
const readValue = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const t = el.matches('input,textarea,select') ? el : (el.querySelector('input:not([type=hidden]),textarea,select') || el);
  if (t.type === 'password') return '***';
  if (t.tagName === 'SELECT') return Array.from(t.selectedOptions).map((o) => o.label).join(', ');
  if ('value' in t && typeof t.value === 'string') {
    if (t.value) return t.value.slice(0, 500);
    if (el !== t) {
      const display = (el.innerText || '').trim();
      const placeholder = t.getAttribute('placeholder') || '';
      if (display && display !== placeholder) return display.slice(0, 500);
    }
    return '';
  }
  return (t.innerText || '').trim().slice(0, 500);
}`;

/** 文件上传：定位实际的 file input（目标自身、子孙或同一表单/父级内）。 */
const findFileInput = `function () {
  if (this.tagName === 'INPUT' && this.type === 'file') return this;
  let n = this;
  for (let i = 0; n && i < 6; i++, n = n.parentElement) {
    const f = n.querySelector && n.querySelector('input[type=file]');
    if (f) return f;
  }
  return null;
}`;

/** 读取并清空指定时间戳之后的瞬时 UI 事件（toast / status / loading）。 */
const readTransientEvents = `function (since) {
  const list = Array.isArray(window.__fastgptUiEvents) ? window.__fastgptUiEvents : [];
  return list.filter((e) => e.timestamp >= since);
}`;

/** 返回当前可见的 loading 遮罩/spinner 描述；空字符串表示页面空闲。 */
const pageBusy = `function () {
  const sel = '.el-loading-mask,.ant-spin-spinning,.ivu-spin-fix,.vxe-loading.is--visible,.n-spin-container--spinning,[aria-busy="true"]';
  for (const n of document.querySelectorAll(sel)) {
    if (n.checkVisibility ? !n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : !n.getClientRects().length) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    return ((n.innerText || '').trim() || n.className || 'loading').toString().slice(0, 80);
  }
  return '';
}`;

/** 为下拉选择器定位可输入的远程搜索框（支持组件内搜索框、当前焦点及可见下拉弹层内搜索框）。 */
const prepareSelectSearch = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const doc = (el && el.ownerDocument) || document;
  const isEditableInput = (n) => n && n.matches && n.matches('input:not([type=hidden]):not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled])') && !['checkbox','radio','file','button','submit','reset'].includes(n.type);
  const visible = (n) => (n.checkVisibility ? n.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : n.getClientRects().length) && n.getBoundingClientRect().width > 0;
  const wrap = (el && el.closest && el.closest('.el-select,.el-cascader,.el-autocomplete,.ant-select,.ant-cascader,.ivu-select,.arco-select,.n-select,.t-select,[role=combobox]')) || el;

  let target = null;
  if (isEditableInput(el)) target = el;
  if (!target && wrap && wrap.querySelectorAll) {
    for (const cand of wrap.querySelectorAll('input,textarea')) {
      if (isEditableInput(cand)) { target = cand; break; }
    }
  }
  if (!target && isEditableInput(doc.activeElement)) {
    target = doc.activeElement;
  }
  if (!target) {
    const popupSel = '.el-select-dropdown,.el-popper,.ant-select-dropdown,[role=listbox],[class*=dropdown],[class*=popover],[class*=popper]';
    const pops = Array.from(doc.querySelectorAll(popupSel)).filter(visible);
    for (let i = pops.length - 1; i >= 0 && !target; i--) {
      for (const cand of pops[i].querySelectorAll('input,textarea')) {
        if (isEditableInput(cand) && visible(cand)) { target = cand; break; }
      }
    }
  }
  if (!target) return { editable: false };
  target.focus();
  const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (setter && target.value) {
    setter.call(target, '');
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { editable: true };
}`;

/** 确保下拉搜索框的值与输入同步并触发 Vue/React 远程搜索事件。 */
const finalizeSelectSearch = `function (text) {
  const doc = (this && this.ownerDocument) || document;
  const active = doc.activeElement;
  if (!active || !('value' in active)) return false;
  const proto = active.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (setter && active.value !== text) {
    setter.call(active, text);
  }
  active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  active.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.slice(-1) || 'a' }));
  return true;
}`;

module.exports = {
  prepareClick, describeElement, fillElement, selectNative, findOptionByText, listVisibleOptions, extractMarkdown,
  pageHasText, waitDomQuiet, scrollTo, scrollState, focusAndClear, prepareSelectSearch, finalizeSelectSearch, readValue, findFileInput,
  readTransientEvents, pageBusy
};
