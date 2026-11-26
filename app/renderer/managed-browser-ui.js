(function (global) {
  'use strict';

  var STATE_LABELS = {
    not_started: '未开始',
    opening: '正在打开专属浏览器',
    awaiting_login: '等待登录',
    login_required: '需要重新登录',
    checking: '正在检查身份',
    awaiting_confirmation: '等待确认绑定',
    bound: '已绑定',
    verified: '身份已核对',
    mismatch: '账号不一致',
    unverifiable: '暂时无法核对',
    closed: '浏览器已关闭',
    error: '操作失败',
    canceled: '已取消'
  };

  var WAIT_LOGIN_TEXT = '在弹出的官方窗口登录，工作台会自动识别、复核并保存到当前老师，无需再点确认绑定。已有登录会保留。';
  var CANCEL_NOTE = '取消本次绑定不会自动退出网站中已登录的账号。';

  function isRecord(value) {
    return value !== null && typeof value === 'object';
  }

  function cleanText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return '';
  }

  function normalizeBrowserKind(value) {
    return value === 'chrome' || value === 'msedge' ? value : '';
  }

  function browserName(kind) {
    return kind === 'msedge' ? 'Edge' : 'Chrome';
  }

  function findAvailability(list, kind) {
    for (var index = 0; index < list.length; index += 1) {
      var item = list[index];
      if (isRecord(item) && item.id === kind) return item;
    }
    return null;
  }

  function defaultMessage(state, isBound, windowOpen) {
    switch (state) {
      case 'not_started':
        return isBound
          ? '专属浏览器已绑定，可打开浏览器或检查身份。'
          : '尚未绑定专属浏览器账号，请选择下方浏览器登录并绑定。';
      case 'opening':
        return '正在启动工作台管理的专属浏览器。';
      case 'awaiting_login':
        return '等待官方窗口中的登录结果。';
      case 'login_required':
        return '请在原专属浏览器重新登录，不需要重建环境；登录后程序会重新核对账号。';
      case 'checking':
        return '正在检查浏览器中的登录身份。';
      case 'awaiting_confirmation':
        return '已读取官方窗口中的账号，请核对后确认绑定。';
      case 'bound':
        return '账号已绑定。绑定不等于可以发布。';
      case 'verified':
        return '浏览器中的登录账号与绑定账号一致。';
      case 'mismatch':
        return '浏览器中的登录账号与绑定账号不一致，请打开专属浏览器核对。';
      case 'unverifiable':
        return '暂时无法核对身份，请稍后重试。';
      case 'closed':
        return isBound
          ? '浏览器已关闭，绑定仍保留，可重新打开。'
          : '浏览器已关闭，本次绑定尚未完成。';
      case 'error':
        return '操作未完成，请稍后重试。';
      case 'canceled':
        return '已取消本次绑定。';
      case 'unknown':
        return '当前状态暂不可识别，请稍后刷新。';
      default:
        return windowOpen ? '专属浏览器窗口已打开。' : '请选择下一步操作。';
    }
  }

  function render(options) {
    var opts = isRecord(options) ? options : {};
    var doc = opts.document;

    if (!doc || typeof doc.createElement !== 'function') {
      throw new TypeError('ManagedBrowserUI.render 需要有效的 document。');
    }

    var account = isRecord(opts.account) ? opts.account : {};
    var binding = isRecord(account.binding) ? account.binding : null;
    var isBound = Boolean(binding && binding.source === 'managed_browser');
    var session = isRecord(opts.session) ? opts.session : {};
    var rawState = cleanText(session.state);
    var state = rawState === ''
      ? 'not_started'
      : (Object.prototype.hasOwnProperty.call(STATE_LABELS, rawState) ? rawState : 'unknown');
    var windowOpen = session.windowOpen === true;
    var busy = opts.busy === true;
    var locked = busy || state === 'opening' || state === 'checking';
    var sessionKind = normalizeBrowserKind(session.browserKind);
    var candidate = isRecord(session.candidate) ? session.candidate : null;
    var availability = Array.isArray(opts.availability) ? opts.availability : [];

    function element(tagName, className, text) {
      var node = doc.createElement(tagName);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function addNote(text) {
      root.appendChild(element('div', 'pair-wait-note', text));
    }

    function call(name, args) {
      var handler = opts[name];
      if (typeof handler !== 'function') return;
      handler.apply(null, args || []);
    }

    function addButton(parent, label, callbackName, args, settings) {
      var config = settings || {};
      var button = element('button', 'button' + (config.variant ? ' ' + config.variant : ''), label);
      button.type = 'button';
      button.disabled = config.disabled === true;
      if (config.title) button.title = config.title;
      button.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (button.disabled) return;
        call(callbackName, args);
      });
      parent.appendChild(button);
      return button;
    }

    var root = element('section', 'account-pair');
    root.setAttribute('data-pair-state', state);
    root.setAttribute('aria-label', '工作台管理的专属浏览器');
    root.appendChild(element('h3', null, '工作台管理的专属浏览器'));
    root.appendChild(element(
      'div',
      'account-meta-line',
      '每位老师的每个平台账号使用独立环境并保留本机登录。不需要安装扩展，也不依赖外部 AI 工具。绑定不代表永久在线；发布前必须重新检查。本卡片只负责连接与身份核对。'
    ));

    if (!isBound) addNote('点击连接后，程序会把官方窗口中核对一致的账号保存到当前老师。账号不一致或读取失败时会显示具体原因。');
    if (session.checkedAt) addNote('最近身份回读：' + new Date(session.checkedAt).toLocaleString('zh-CN'));
    if (isBound) {
      var bindingLine = element('div', 'account-meta-line');
      bindingLine.appendChild(element('span', null, '已绑定真实账号：'));
      var bindingId = cleanText(binding.platformAccountId);
      if (bindingId) {
        bindingLine.appendChild(element('span', 'account-real-id', bindingId));
      } else {
        bindingLine.appendChild(element('span', null, '未返回账号标识'));
      }
      root.appendChild(bindingLine);
    }

    var statusLine = element('div', 'pair-state-line');
    statusLine.setAttribute('role', 'status');
    statusLine.setAttribute('aria-live', 'polite');
    statusLine.setAttribute('aria-atomic', 'true');
    statusLine.appendChild(element('b', null, STATE_LABELS[state] || STATE_LABELS.unknown));
    var sessionMessage = state === 'unknown' ? '' : cleanText(session.message).slice(0, 300);
    statusLine.appendChild(element(
      'span',
      null,
      sessionMessage || defaultMessage(state, isBound, windowOpen)
    ));
    root.appendChild(statusLine);

    if ((state === 'awaiting_login' || state === 'login_required') && sessionMessage !== WAIT_LOGIN_TEXT) {
      addNote(WAIT_LOGIN_TEXT);
    }

    if (!isBound && sessionKind) {
      addNote('当前只使用已分配的 ' + browserName(sessionKind) + ' 浏览器，不能切换，也不提供其他浏览器选项。');
    }

    if (state === 'canceled' || (!isBound && windowOpen)) {
      addNote(CANCEL_NOTE);
    }

    if (!isBound && candidate) {
      var candidatePanel = element('div', 'pair-candidate');
      candidatePanel.appendChild(element('b', null, '识别到待绑定账号'));
      var candidateId = cleanText(candidate.platformAccountId);
      var displayName = cleanText(candidate.displayName);

      if (candidateId) {
        candidatePanel.appendChild(element('div', 'pair-candidate-id', candidateId));
      } else {
        candidatePanel.appendChild(element('div', 'pair-wait-note', '官方窗口未返回真实账号标识，已禁止确认。'));
      }
      if (displayName) {
        candidatePanel.appendChild(element('small', null, '昵称：' + displayName));
      }

      var candidateActions = element('div', 'pair-candidate-actions');
      var confirmDisabled = !candidateId
        || !windowOpen
        || locked
        || state !== 'awaiting_confirmation';
      addButton(candidateActions, '确认绑定此账号', 'onConfirm', [], {
        variant: 'button-primary',
        disabled: confirmDisabled
      });
      candidatePanel.appendChild(candidateActions);

      if (candidateId && !windowOpen) {
        candidatePanel.appendChild(element('div', 'pair-wait-note', '官方窗口已关闭，请重新打开专属浏览器后再确认。'));
      } else if (candidateId && state !== 'awaiting_confirmation') {
        candidatePanel.appendChild(element('div', 'pair-wait-note', '请等待工作台完成账号识别后再确认。'));
      } else if (candidateId && locked) {
        candidatePanel.appendChild(element('div', 'pair-wait-note', '正在处理，请稍候。'));
      }

      root.appendChild(candidatePanel);
    }

    var actions = element('div', 'account-actions');
    var hasActions = false;

    if (isBound) {
      var kindForOpen = sessionKind;
      var openDisabled = locked || !kindForOpen;
      var availabilityForBound = kindForOpen ? findAvailability(availability, kindForOpen) : null;
      var boundBrowserUnavailable = !availabilityForBound || availabilityForBound.available !== true;
      if (boundBrowserUnavailable) openDisabled = true;

      addButton(actions, state === 'login_required' ? '打开原窗口重新登录' : '打开专属浏览器', 'onOpen', kindForOpen ? [kindForOpen] : [], {
        variant: 'button-primary',
        disabled: openDisabled
      });
      addButton(actions, '检查身份', 'onCheck', [], {
        variant: 'button-outline',
        disabled: busy || !windowOpen
      });
      addButton(actions, '关闭浏览器', 'onClose', [], {
        variant: 'button-quiet',
        disabled: locked || !windowOpen
      });
      addButton(actions, '解除绑定', 'onUnbind', [], {
        variant: 'button-quiet',
        disabled: locked
      });
      hasActions = true;

      if (!kindForOpen) {
        addNote('暂未识别专属浏览器类型，暂时无法打开。');
      } else if (boundBrowserUnavailable) {
        addNote('未检测到浏览器，暂时无法打开专属浏览器。');
      }
    } else {
      if (!windowOpen) {
        var kinds = sessionKind ? [sessionKind] : ['chrome', 'msedge'];
        for (var index = 0; index < kinds.length; index += 1) {
          var kind = kinds[index];
          var availabilityItem = findAvailability(availability, kind);
          var available = Boolean(availabilityItem && availabilityItem.available === true);
          var availabilityLabel = cleanText(availabilityItem && availabilityItem.label)
            || browserName(kind);

          addButton(
            actions,
            '用' + browserName(kind) + '登录并连接',
            'onOpen',
            [kind],
            {
              variant: 'button-primary',
              disabled: locked || !available,
              title: available ? '' : '未检测到浏览器'
            }
          );
          hasActions = true;

          if (!available) {
            addNote('未检测到浏览器（' + availabilityLabel + '）');
          }
        }

        if (!sessionKind) {
          addNote('请选择本机已检测到的浏览器；未检测到的选项不可用，也不提供安装或自选可执行文件。');
        }
      }

      if (windowOpen) {
        if (sessionKind && state !== 'awaiting_confirmation') {
          addButton(actions, '继续连接', 'onOpen', [sessionKind], {
            variant: 'button-primary',
            disabled: busy || state === 'opening'
          });
          addNote('如果已扫码进入后台但这里仍未绑定，可重新读取当前账号；不会要求重新扫码。');
        }
        addButton(actions, '取消本次绑定', 'onCancel', [], {
          variant: 'button-outline',
          disabled: busy
        });
        addButton(actions, '关闭浏览器', 'onClose', [], {
          variant: 'button-quiet',
          disabled: busy
        });
        hasActions = true;
      }
    }

    if (hasActions) root.appendChild(actions);

    return root;
  }

  global.ManagedBrowserUI = {
    render: render
  };
})(typeof window !== 'undefined' ? window : globalThis);
