// 基于 Chromium 无障碍树生成给 Agent 阅读的缩进文本快照。
// 引用 ref 绑定 backendDOMNodeId，同一文档内保持稳定，导航后由 TabManager 清空。

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'treeitem', 'gridcell', 'columnheader', 'rowheader', 'row', 'cell', 'Date', 'DateTime', 'Time',
  'InputTime', 'textField', 'TextField', 'PopUpButton', 'image', 'img', 'heading', 'dialog',
  'alertdialog', 'table', 'grid', 'list', 'listitem', 'form', 'menu', 'menubar', 'tree', 'tablist',
  'navigation', 'main', 'region', 'search', 'article', 'tabpanel', 'figure', 'DisclosureTriangle'
]);
const FORM_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'button', 'dialog', 'alertdialog', 'form', 'Date', 'DateTime', 'Time',
  'InputTime', 'textField', 'TextField', 'PopUpButton'
]);
// 结构上无意义的节点，直接把子节点提升到当前层级
const TRANSPARENT = new Set([
  'generic', 'none', 'presentation', 'GenericContainer', 'LayoutTable',
  'Section', 'group', 'Div', 'Span', 'Pre', 'Canvas', 'Abbr', 'Ruby',
  'LabelText', 'Unknown', 'emphasis', 'strong', 'mark', 'Mark', 'subscript', 'superscript',
  'time', 'code', 'deletion', 'insertion', 'blockquote', 'Legend', 'contentinfo', 'banner',
  'complementary', 'note', 'status', 'log', 'marquee', 'timer', 'paragraph', 'IframePresentational'
]);
const SKIP = new Set(['InlineTextBox', 'LineBreak', 'ListMarker', 'ignored']);
const STATE_PROPS = ['checked', 'pressed', 'expanded', 'selected', 'disabled', 'required', 'readonly', 'focused', 'invalid', 'level', 'multiselectable', 'haspopup', 'modal'];

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function quote(text) {
  return JSON.stringify(text);
}

/** 为节点分配稳定引用；同时记录角色/名称，供前端重渲染后重新定位。 */
function refFor(tab, backendId, frameId, meta) {
  if (!backendId) return;
  const key = frameId + ':' + backendId;
  let ref = tab.refs.byBackend.get(key);
  if (!ref) {
    // 序号由 TabManager 全局分配：跨标签、跨文档唯一，旧 ref 不会被复用到新元素上。
    const seq = tab.allocRef ? tab.allocRef() : (tab.refs.counter = (tab.refs.counter || 0) + 1);
    ref = 'e' + seq;
    tab.refs.byBackend.set(key, ref);
    tab.refs.byRef.set(ref, {
      backendId,
      frameId,
      seq,
      role: meta?.role,
      name: meta?.name
    });
  }
  return ref;
}

// 表格单元格内存在这些控件时不折叠该行，保证控件仍有独立 ref。
const ROW_CONTROLS = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'spinbutton',
  'slider', 'listbox', 'menuitem', 'Date', 'DateTime', 'Time', 'PopUpButton'
]);
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader', 'LayoutTableCell']);

/** 递归收集帧树，返回 [{id, url, parentId}]。 */
function flattenFrames(tree, list = [], parentId = null) {
  if (!tree) return list;
  list.push({ id: tree.frame.id, url: tree.frame.url, parentId });
  for (const child of tree.childFrames || []) flattenFrames(child, list, tree.frame.id);
  return list;
}

/**
 * 读取所有可访问帧的无障碍树。跨进程 iframe（OOPIF）在 Electron debugger 下无法读取时跳过。
 * 返回 { frames: Map(frameId -> {nodes, byId, root}), owners: Map(ownerBackendId -> frameId), mainFrameId }
 */
async function readTrees(cdp) {
  const { frameTree } = await cdp('Page.getFrameTree');
  const frames = flattenFrames(frameTree);
  const result = new Map();
  const owners = new Map();
  for (const frame of frames.slice(0, 30)) {
    try {
      const { nodes } = await cdp('Accessibility.getFullAXTree', frame.parentId ? { frameId: frame.id } : {});
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId));
      result.set(frame.id, { nodes, byId, root });
      if (frame.parentId) {
        const owner = await cdp('DOM.getFrameOwner', { frameId: frame.id }).catch(() => null);
        if (owner?.backendNodeId) owners.set(owner.backendNodeId, frame.id);
      }
    } catch {}
  }
  return { frames: result, owners, mainFrameId: frameTree.frame.id };
}

function props(node) {
  const map = {};
  for (const prop of node.properties || []) map[prop.name] = prop.value?.value;
  return map;
}

/**
 * 生成文本快照。
 * @param {object} options.ref 仅输出该引用对应的子树
 * @param {string} options.selector CSS 选择器，定位局部容器（如 ".el-drawer"、".el-select-dropdown"）
 * @param {number} options.offset 从第几行开始（分页）
 * @param {number} options.maxChars 输出字符预算
 * @param {boolean} options.interactive 仅输出带引用的可交互节点（紧凑模式）
 * @param {boolean} options.formOnly 仅输出表单控件、按钮与弹层
 */
async function snapshot(tab, cdp, { ref, selector, offset = 0, maxChars = 12000, interactive = false, formOnly = false } = {}) {
  let scopeIds = null;
  if (selector && !ref) {
    const evalRes = await cdp('Runtime.evaluate', {
      expression: `(() => {
        const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const vis = list.filter((e) => e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : e.getClientRects().length > 0);
        return vis.length ? vis[vis.length - 1] : list[0] || null;
      })()`
    });
    const objectId = evalRes?.result?.objectId;
    if (!objectId) throw agentError('selector_not_found', '页面上未找到匹配选择器 ' + selector + ' 的元素');
    try {
      const desc = await cdp('DOM.describeNode', { objectId, depth: -1, pierce: true });
      scopeIds = new Set();
      const collect = (n) => {
        if (!n) return;
        if (n.backendNodeId) scopeIds.add(n.backendNodeId);
        for (const c of n.children || []) collect(c);
        for (const s of n.shadowRoots || []) collect(s);
        if (n.contentDocument) collect(n.contentDocument);
      };
      collect(desc?.node);
    } finally {
      await cdp('Runtime.releaseObject', { objectId }).catch(() => {});
    }
    if (!scopeIds || scopeIds.size === 0) throw agentError('selector_not_found', '无法解析选择器 ' + selector + ' 对应的节点');
  }
  const { frames, owners, mainFrameId } = await readTrees(cdp);
  const lines = [];
  const visited = new Set();
  const rowWithControls = new Set();

  const renderFrame = (frameId, depth) => {
    const frame = frames.get(frameId);
    if (!frame?.root) return;
    renderNode(frame, frameId, frame.root, depth, '');
  };

  const textOf = (frame, node) => {
    // 子节点只有静态文本时，名称已经覆盖内容
    let text = '';
    for (const id of node.childIds || []) {
      const child = frame.byId.get(id);
      if (!child) continue;
      const role = child.role?.value;
      if (role === 'StaticText') text += child.name?.value || '';
      else if (!SKIP.has(role)) return null;
    }
    return text;
  };

  function renderNode(frame, frameId, node, depth, parentName) {
    const key = frameId + ':' + node.nodeId;
    if (visited.has(key) || depth > 80) return;
    visited.add(key);
    const role = node.role?.value || '';
    let name = clip(node.name?.value, 300);
    if (!name && ['listitem', 'option', 'menuitem', 'treeitem'].includes(role)) {
      const parts = [];
      const gatherText = (n, d) => {
        if (!n || d > 5 || parts.join('').length > 200) return;
        if (n.role?.value === 'StaticText' && n.name?.value) parts.push(n.name.value);
        for (const cid of n.childIds || []) gatherText(frame.byId.get(cid), d + 1);
      };
      gatherText(node, 0);
      name = clip(parts.join(' '), 300);
    }
    const children = node.childIds || [];
    const recurse = (nextDepth, nameForChildren) => {
      for (const id of children) {
        const child = frame.byId.get(id);
        if (child) renderNode(frame, frameId, child, nextDepth, nameForChildren);
      }
      // iframe 所有者节点下挂载子帧内容
      if (node.backendDOMNodeId && owners.has(node.backendDOMNodeId)) {
        renderFrame(owners.get(node.backendDOMNodeId), nextDepth);
      }
    };
    if (scopeIds && frameId === mainFrameId && !inScope(frame, node)) return;
    if (node.ignored || SKIP.has(role)) return recurse(depth, parentName);
    if (role === 'RootWebArea' || role === 'WebArea') {
      if (frameId !== mainFrameId) lines.push('  '.repeat(depth) + '- iframe ' + quote(name));
      return recurse(frameId !== mainFrameId ? depth + 1 : depth, '');
    }
    if (role === 'Iframe') return recurse(depth, parentName);
    if (role === 'StaticText') {
      if (interactive || formOnly || !name || parentName.includes(name)) return;
      const indent = '  '.repeat(depth);
      const last = lines[lines.length - 1];
      // 合并相邻文本，减少行数
      if (last && last.startsWith(indent + '- text: ') && last.length < 400) {
        lines[lines.length - 1] = last.slice(0, -1) + ' ' + JSON.stringify(name).slice(1);
      } else {
        lines.push(indent + '- text: ' + quote(clip(node.name?.value, 500)));
      }
      return;
    }
    const p = props(node);
    if (p.hidden === true || p.hidden === 'true') return;
    const value = node.value?.value;
    const focusable = p.focusable === true;
    const named = !!name;
    if (TRANSPARENT.has(role) && !focusable && !(named && role === 'group')) return recurse(depth, parentName);

    const isInteractive = INTERACTIVE.has(role) || focusable || p.editable;
    if (interactive && !isInteractive) return recurse(depth, parentName);
    if (formOnly && !FORM_ROLES.has(role) && !p.editable) return recurse(depth, parentName);

    // 宽表（几十列 × 多行）逐格输出会产生上千个 ref 并截断快照：
    // 没有控件的行（含 Chromium 将无表头 tbody 归类为 LayoutTableRow 的情况）折叠为一行 "A | B | C"。
    if (role === 'row' || role === 'LayoutTableRow') {
      const collapsed = collapseRow(frame, node);
      if (collapsed !== null) {
        const r = refFor(tab, node.backendDOMNodeId, frameId, { role: 'row', name });
        lines.push('  '.repeat(depth) + '- row ' + quote(collapsed) + (r ? ' [ref=' + r + ']' : ''));
        return;
      }
      rowWithControls.add(node.nodeId);
      if (role === 'LayoutTableRow') return recurse(depth, parentName);
    }
    if (role === 'LayoutTableCell') return recurse(depth, parentName);
    // 含控件的宽表行中：冻结列的空白占位格与只读静态金额格（如 "0.00"）不输出，只保留含控件/可聚焦的单元格，
    // 避免一行 25 个 "0.00" 锁定期间把真正可编辑的输入框挤出快照窗口。
    if ((role === 'cell' || role === 'gridcell' || role === 'columnheader') && !focusable && !p.editable && !hasControl(frame, node)) {
      if (!named && !clip(collectText(frame, node), 200)) return;
      if ((role === 'cell' || role === 'gridcell') && rowWithControls.has(node.parentId)) return;
    }

    let line = '  '.repeat(depth) + '- ' + role + (named ? ' ' + quote(name) : '');
    const r = isInteractive && !((role === 'cell' || role === 'gridcell') && !focusable && !p.editable && children.length > 0 && hasControl(frame, node))
      ? refFor(tab, node.backendDOMNodeId, frameId, { role, name })
      : undefined;
    if (r) line += ' [ref=' + r + ']';
    for (const prop of STATE_PROPS) {
      const v = p[prop];
      if (v === undefined || v === false || v === 'false' || v === '') continue;
      if (prop === 'focused' && !v) continue;
      if (prop === 'haspopup' && (v === 'false' || role === 'combobox')) continue;
      line += v === true || v === 'true' ? ' [' + prop + ']' : ' [' + prop + '=' + v + ']';
    }
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role) && (p.checked === undefined || p.checked === 'false' || p.checked === false)) line += ' [unchecked]';
    if (value !== undefined && value !== '' && value !== name) {
      const masked = p.protected || /password/i.test(node.description?.value || '') ? '***' : clip(value, 300);
      line += ' [value=' + quote(masked) + ']';
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      const placeholder = p.placeholder || node.description?.value;
      if (placeholder && placeholder !== name && !value) line += ' [placeholder=' + quote(clip(placeholder, 100)) + ']';
    }
    if (role === 'link' && p.url && !interactive) line += ' [url=' + clip(p.url, 200) + ']';
    const text = textOf(frame, node);
    if (text !== null && clip(text, 300) === name) {
      lines.push(line);
      if (node.backendDOMNodeId && owners.has(node.backendDOMNodeId)) renderFrame(owners.get(node.backendDOMNodeId), depth + 1);
      return;
    }
    lines.push(line + (children.length ? ':' : ''));
    recurse(depth + 1, name);
  }

  const inScopeMemo = new Map();

  /** 收集节点下的静态文本（有限深度），用于无名称的单元格。 */
  function collectText(frame, node, depth = 0) {
    if (!node || depth > 6) return '';
    if (node.role?.value === 'StaticText') return node.name?.value || '';
    let text = '';
    for (const id of node.childIds || []) {
      text += collectText(frame, frame.byId.get(id), depth + 1);
      if (text.length > 200) break;
    }
    return text;
  }

  /** 子树内是否存在需要独立 ref 的控件。 */
  function hasControl(frame, node, depth = 0) {
    if (!node || depth > 10) return false;
    if (depth > 0 && !node.ignored) {
      const role = node.role?.value;
      if (ROW_CONTROLS.has(role) || props(node).editable) return true;
    }
    for (const id of node.childIds || []) {
      if (hasControl(frame, frame.byId.get(id), depth + 1)) return true;
    }
    return false;
  }

  /** 可折叠时返回 "A | B | C"，否则返回 null（行内有控件或单元格过少）。 */
  function collapseRow(frame, node) {
    const cells = [];
    const gather = (n, d) => {
      for (const id of n.childIds || []) {
        const child = frame.byId.get(id);
        if (!child) continue;
        if (CELL_ROLES.has(child.role?.value)) cells.push(child);
        else if (d < 2 && (child.ignored || TRANSPARENT.has(child.role?.value))) gather(child, d + 1);
      }
    };
    gather(node, 0);
    if (cells.length < 2 || hasControl(frame, node)) return null;
    return clip(cells.map((cell) => clip(cell.name?.value || collectText(frame, cell), 80)).join(' | '), 2000);
  }
  function inScope(frame, node) {
    if (!scopeIds) return true;
    if (node.backendDOMNodeId && scopeIds.has(node.backendDOMNodeId)) return true;
    if (inScopeMemo.has(node.nodeId)) return inScopeMemo.get(node.nodeId);
    let ok = false;
    for (const cid of node.childIds || []) {
      const child = frame.byId.get(cid);
      if (child && inScope(frame, child)) {
        ok = true;
        break;
      }
    }
    inScopeMemo.set(node.nodeId, ok);
    return ok;
  }

  if (ref) {
    const target = tab.refs.byRef.get(ref);
    if (!target) throw agentError('ref_not_found', '引用不存在或已失效，请重新 snapshot');
    const frame = frames.get(target.frameId);
    const node = frame?.nodes.find((item) => item.backendDOMNodeId === target.backendId);
    if (!node) throw agentError('ref_stale', '元素已不在页面中，请重新 snapshot');
    renderNode(frame, target.frameId, node, 0, '');
  } else {
    renderFrame(mainFrameId, 0);
  }

  // 去掉末尾无子节点的冒号
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith(':')) {
      const indent = lines[i].length - lines[i].trimStart().length;
      const next = lines[i + 1];
      if (!next || next.length - next.trimStart().length <= indent) lines[i] = lines[i].slice(0, -1);
    }
  }

  let used = 0;
  let end = offset;
  const out = [];
  while (end < lines.length && used + lines[end].length + 1 <= maxChars) {
    out.push(lines[end]);
    used += lines[end].length + 1;
    end++;
  }
  return {
    content: out.join('\n'),
    totalLines: lines.length,
    nextOffset: end < lines.length ? end : undefined
  };
}

function agentError(code, hint) {
  const error = new Error(code);
  error.agent = { error: code, hint };
  return error;
}

module.exports = { snapshot, agentError, readTrees };
