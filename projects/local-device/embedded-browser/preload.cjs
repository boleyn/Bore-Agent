const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#browser-toolbar');
  const address = form.querySelector('input');
  const pause = document.querySelector('#pause');
  const paths = {
    back: 'M15 5l-7 7 7 7',
    go: 'M5 12h14m-6-6 6 6-6 6',
    refresh: 'M20 5v5h-5 M20 10a8 8 0 1 0 0 5',
    pause: 'M8 5v14M16 5v14',
    play: 'M7 4l12 8-12 8z',
    add: 'M12 5v14M5 12h14',
    save: 'M4 12l5 5L20 6',
    remove: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
    settings: 'M3 7h7m5 0h6M3 17h11m5 0h2 M10 4v6h5V4z M14 14v6h5v-6z',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 5-5 5-13 0-18z',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 1 1 12 0m-2 5 6 6'
  };
  const symbols = {
    后退: 'back',
    刷新: 'refresh',
    打开: 'go',
    '暂停 Agent': 'pause',
    '恢复 Agent': 'play',
    连接设置: 'settings',
    添加账号: 'add',
    保存: 'save',
    '‹ 授权管理': 'back',
    暂停: 'pause',
    恢复: 'play',
    移除: 'remove',
    撤销会话: 'remove'
  };

  /** 可见图标、悬停提示和辅助功能名称随操作状态一起更新。 */
  function drawIcon(element, symbol, label) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.7',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true'
    }))
      svg.setAttribute(key, value);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', paths[symbol]);
    svg.append(path);
    element.replaceChildren(svg);
    if (label) {
      element.classList.add('icon');
      const hints = {
        '暂停 Agent': '暂停 Agent 操作此页',
        '恢复 Agent': '恢复 Agent 操作此页',
        暂停: '暂停此账号的授权',
        恢复: '恢复此账号的授权',
        移除: '移除此账号',
        打开: '打开输入的网址',
        '‹ 授权管理': '返回授权管理'
      };
      element.dataset.tip = hints[label] || label;
      element.setAttribute('aria-label', label);
    }
  }
  for (const element of document.querySelectorAll('button')) {
    const label = element.getAttribute('aria-label') || element.textContent.trim();
    if (symbols[label]) drawIcon(element, symbols[label], label);
  }
  for (const element of document.querySelectorAll('[data-symbol]'))
    drawIcon(element, element.dataset.symbol);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ipcRenderer.send('browser-control', 'navigate', address.value);
  });
  for (const action of ['back', 'reload', 'pause', 'show-management']) {
    document
      .querySelector('#' + action)
      .addEventListener('click', () => ipcRenderer.send('browser-control', action));
  }
  const managementTab = document.querySelector('#show-management');
  const tabList = document.querySelector('#tab-list');
  const tabStrip = document.querySelector('#tab-strip');
  document
    .querySelector('#new-tab')
    .addEventListener('click', () => ipcRenderer.send('browser-control', 'new-tab'));
  /** 标签页按 id 渲染，点击切换，关闭按钮只关闭对应标签。 */
  function renderTabs(tabs = [], manage = false) {
    tabList.replaceChildren(
      ...tabs.map((tab) => {
        const item = document.createElement('div');
        item.className = 'tab';
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', String(!manage && tab.active));
        item.title = tab.title;
        const label = document.createElement('span');
        label.textContent = (tab.loading ? '· ' : '') + tab.title;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'close';
        close.textContent = '×';
        close.setAttribute('aria-label', '关闭标签页');
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          ipcRenderer.send('browser-control', 'close-tab', tab.id);
        });
        item.addEventListener('click', () => ipcRenderer.send('browser-control', 'select-tab', tab.id));
        item.append(label, close);
        return item;
      })
    );
  }
  ipcRenderer.on('browser-state', (_event, { url, paused, integrated, manage, tabs }) => {
    managementTab.hidden = !integrated;
    managementTab.setAttribute('aria-selected', String(manage));
    form.hidden = manage;
    tabStrip.hidden = false;
    renderTabs(tabs, manage);
    document.querySelector('#management').hidden = !manage;
    if (document.activeElement !== address) address.value = url;
    drawIcon(pause, paused ? 'play' : 'pause', paused ? '恢复 Agent' : '暂停 Agent');
    pause.setAttribute('aria-pressed', String(paused));
  });
  const request = (action = '') => ipcRenderer.send('browser-control', 'management', action);
  const platform = document.querySelector('#platform');
  document.querySelector('#refresh-management').addEventListener('click', () => request());
  for (const [id, prefix, field] of [
    ['settings', 'settings:', platform],
    ['invite', 'invite:', document.querySelector('#invite-url')]
  ]) {
    document.querySelector('#' + id).addEventListener('submit', (event) => {
      event.preventDefault();
      if (field.value.trim()) request(prefix + field.value.trim());
    });
  }
  let accounts = [];
  let selectedID;
  const search = document.querySelector('#account-search');
  const list = document.querySelector('#accounts');
  const details = document.querySelector('#detail-content');
  const pages = {
    list: document.querySelector('#account-list'),
    settings: document.querySelector('#settings-page'),
    invite: document.querySelector('#invite-page'),
    details: document.querySelector('#details-page')
  };

  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  const showPage = (page) => {
    for (const [name, element] of Object.entries(pages)) element.hidden = name !== page;
  };
  for (const button of document.querySelectorAll('[data-page]')) {
    button.addEventListener('click', () => {
      selectedID = undefined;
      showPage(button.dataset.page);
    });
  }

  const button = (label, onClick, className) => {
    const element = node('button', label, className);
    if (symbols[label]) drawIcon(element, symbols[label], label);
    element.type = 'button';
    element.addEventListener('click', onClick);
    return element;
  };

  // 与原生管理页使用同一组头像来源，图片不可用时保留姓名首字。
  const avatar = (account) => {
    const badge = node('span', account.name?.trim().slice(0, 1) || '用', 'avatar');
    if (!account.avatar) return badge;
    try {
      const base = new URL(account.platform);
      const url = new URL(account.avatar, base);
      const local =
        url.origin === base.origin && /^\/(imgs\/avatar|api\/system\/img)\//.test(url.pathname);
      if (
        (!local && url.origin !== 'https://s3-imfile.feishucdn.com') ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return badge;
      const photo = new Image();
      photo.alt = '';
      photo.referrerPolicy = 'no-referrer';
      photo.onload = () => badge.replaceChildren(photo);
      photo.src = url.href;
    } catch {
      /* 旧绑定可能没有有效的平台地址。 */
    }
    return badge;
  };

  const status = (account) => {
    const labels = { active: '长期授权', paused: '已暂停', legacy: '按会话授权' };
    const badge = node('span', labels[account.state] ?? '已绑定', 'pill');
    badge.dataset.state = account.state;
    return badge;
  };

  const renderDetails = (account) => {
    const header = node('div', '', 'heading');
    const copy = node('div', '', 'heading-copy');
    copy.append(
      node('h1', account.name),
      node('p', [account.team, account.platform].filter(Boolean).join(' · '))
    );
    header.append(avatar(account), copy, status(account));
    details.replaceChildren(header);
    if (account.workdir) details.append(node('p', '默认目录　' + account.workdir, 'card'));
    const sessions = account.sessions || [];
    details.append(
      node('h2', '会话授权' + (account.historyUnavailable ? '' : ' · ' + sessions.length))
    );
    if (account.historyUnavailable || !sessions.length) {
      details.append(
        node('p', account.historyUnavailable ? '暂时无法读取会话授权' : '暂无会话授权', 'empty')
      );
    } else {
      for (const session of sessions) {
        const row = node('div', '', 'session card');
        const info = node('div', '', 'identity');
        info.append(node('strong', session.title), node('p', session.app));
        row.append(
          info,
          node('span', session.status, 'pill'),
          button(
            '撤销会话',
            () => {
              if (window.confirm('撤销此会话的本机授权？'))
                request('revoke-session:' + session.id + ':' + account.id);
            },
            'danger'
          )
        );
        details.append(row);
      }
    }
  };

  const renderList = () => {
    const term = search.value.trim().toLocaleLowerCase();
    const matching = accounts.filter((account) =>
      [account.name, account.team, account.platform].some((value) =>
        value?.toLocaleLowerCase().includes(term)
      )
    );
    document.querySelector('#account-count').textContent =
      matching.length + ' / ' + accounts.length;
    list.replaceChildren();
    if (!matching.length) {
      list.append(node('li', accounts.length ? '没有匹配的用户' : '还没有已绑定用户', 'empty'));
    }
    for (const account of matching) {
      const row = node('li', '', 'account card');
      const identity = node('div', '', 'identity');
      const name = button(
        account.name + ' ›',
        () => {
          selectedID = account.id;
          renderDetails(account);
          showPage('details');
        },
        'name'
      );
      name.setAttribute('aria-label', '查看 ' + account.name + ' 的会话授权');
      identity.append(
        name,
        node('p', [account.team, account.platform].filter(Boolean).join(' · '))
      );
      const actions = node('div', '', 'actions');
      const paused = account.state === 'paused';
      actions.append(
        button(paused ? '恢复' : '暂停', () =>
          request((paused ? 'resume:' : 'pause:') + account.id)
        ),
        button(
          '移除',
          () => {
            if (window.confirm('移除此账号并撤销本机访问？')) request('remove:' + account.id);
          },
          'danger'
        )
      );
      row.append(avatar(account), identity, status(account), actions);
      list.append(row);
    }
    if (selectedID) {
      const selected = accounts.find(({ id }) => id === selectedID);
      if (selected) renderDetails(selected);
      else {
        selectedID = undefined;
        showPage('list');
      }
    }
  };
  search.addEventListener('input', renderList);
  ipcRenderer.on('management-state', (_event, snapshot) => {
    if (!snapshot) return;
    if (snapshot.status) document.querySelector('#connection-status').textContent = snapshot.status;
    if (snapshot.address && document.activeElement !== platform) platform.value = snapshot.address;
    document.querySelector('#management-error').textContent = snapshot.error || '';
    if (Array.isArray(snapshot.accounts)) {
      accounts = snapshot.accounts;
      renderList();
    }
  });
});
