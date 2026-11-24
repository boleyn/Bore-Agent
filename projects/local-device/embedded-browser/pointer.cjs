// 隔离世界只接收连接器的坐标和动作类型，指针不读取字段内容、不参与页面命中。
const { ipcRenderer } = require('electron');

const SVG_NS = 'http://www.w3.org/2000/svg';
// 与 demo 方案 B 一致的光标轮廓（尖头左上，尾部右下）。
const CURSOR_PATH = 'M0 0 L98 75 L56 82 L79 122 L64 130 L42 90 L8 127 Z';

let marker;
let placed = false;
let editUntil = 0;

function svgNode(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/** 三色沿轮廓从尖头到尾部过渡：橙 → 绿 → 蓝；多层不同模糊半径叠加，让外扩更柔和。 */
function buildCursor() {
  const svg = svgNode('svg', {
    width: '18',
    height: '24',
    viewBox: '0 0 100 132',
    style: 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none'
  });
  const defs = svgNode('defs', {});
  const gradient = svgNode('linearGradient', {
    id: 'agent-pointer-gradient',
    x1: '0%',
    y1: '0%',
    x2: '55%',
    y2: '100%'
  });
  for (const [offset, color] of [
    ['0%', '#eb6100'],
    ['50%', '#22ac38'],
    ['100%', '#0058a7']
  ]) {
    gradient.append(svgNode('stop', { offset, 'stop-color': color }));
  }
  const blur = (id, deviation) => {
    const filter = svgNode('filter', { id, x: '-80%', y: '-80%', width: '260%', height: '260%' });
    filter.append(svgNode('feGaussianBlur', { stdDeviation: deviation }));
    return filter;
  };
  defs.append(gradient, blur('agent-pointer-blur-wide', '12'), blur('agent-pointer-blur-mid', '5.5'), blur('agent-pointer-blur-tight', '1.8'));
  svg.append(defs);

  const stroke = (width, filter, opacity) =>
    svgNode('path', {
      d: CURSOR_PATH,
      fill: 'none',
      stroke: 'url(#agent-pointer-gradient)',
      'stroke-width': width,
      'stroke-linejoin': 'round',
      ...(filter ? { filter } : {}),
      opacity
    });

  svg.append(
    stroke('32', 'url(#agent-pointer-blur-wide)', '0.38'),
    stroke('20', 'url(#agent-pointer-blur-mid)', '0.6'),
    stroke('10', 'url(#agent-pointer-blur-tight)', '0.88'),
    stroke('3.6', undefined, '0.95'),
    svgNode('path', {
      d: CURSOR_PATH,
      fill: '#fff',
      stroke: '#202a3a',
      'stroke-width': '3',
      'stroke-linejoin': 'round'
    })
  );
  return svg;
}

function ensureMarker() {
  if (marker?.isConnected) return marker;
  if (!document.documentElement) return undefined;
  marker = document.createElement('div');
  marker.setAttribute('aria-hidden', 'true');
  marker.setAttribute('data-fastgpt-pointer', '1');
  marker.style.cssText =
    'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none!important;z-index:2147483647;transition:transform .16s ease-out;opacity:1';
  const shadow = marker.attachShadow({ mode: 'closed' });
  const label = document.createElement('span');
  label.style.cssText =
    'position:absolute;left:13px;top:18px;background:#202a3a;color:white;white-space:nowrap;border-radius:4px;padding:2px 6px;font:600 11px/15px system-ui;pointer-events:none';
  shadow.append(buildCursor(), label);
  document.documentElement.append(marker);
  marker.label = label;
  return marker;
}

/** 仅在 Agent 实际操作（点击/悬停/滚动/填写）时显示并移动光标，平时不遮挡页面。 */
function showPointer(x, y, action) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const node = ensureMarker();
  if (!node) return;
  placed = true;
  node.label.textContent = 'Agent · ' + action;
  node.style.transform = 'translate(' + x + 'px,' + y + 'px)';
}

ipcRenderer.on('agent-pointer', (_event, message) => {
  if (message.action === 'edit') {
    editUntil = performance.now() + 1500;
    return;
  }
  showPointer(message.x, message.y, message.action);
});
window.addEventListener(
  'input',
  (event) => {
    if (!editUntil || performance.now() > editUntil) return;
    editUntil = 0;
    const rect = event.target?.getBoundingClientRect?.();
    if (rect) showPointer(rect.left + rect.width / 2, rect.top + rect.height / 2, '填写');
  },
  true
);
