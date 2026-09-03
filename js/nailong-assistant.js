/* ============================================================
 * 奶龙 AI 助手（前端组件）—— 创智算网站
 * 功能：悬浮走动 + 10秒切换动作 + 点击弹窗对话 + 指令导航
 *       + 右键菜单（固定/走动、隐藏/显示）+ 状态记忆(localStorage)
 * 依赖：/js/nailong/pose1~13.png（透明PNG）、/api/chat（后端代理）
 * ============================================================ */
(function () {
  // -------- 状态记忆（localStorage） --------
  var LS_KEY = 'nailong_state';
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        return { walking: s.walking !== false, shown: s.shown !== false };
      }
    } catch (e) { }
    return { walking: true, shown: true };
  }
  function saveState(st) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) { }
  }

  // -------- 登录检测（登录且已付费/管理员才显示奶龙） --------
  function init() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var me = window.__czsMe;
      if (me && me.ok && (me.paid || me.isAdmin)) {
        clearInterval(timer);
        buildAssist();
        return;
      }
      // 明确未登录、未付费，或超时 → 不显示奶龙
      if (me && me.ok && !me.paid && !me.isAdmin) {
        clearInterval(timer); // 未付费：等付费后 __czsRefreshAuth 重新触发本脚本？——脚本只执行一次；不再显示
        return;
      }
      if ((me && me.ok === false) || tries > 20) {
        clearInterval(timer);
        return;
      }
    }, 500);
  }

  function buildAssist() {
    if (document.getElementById('nailong-assist')) return;
    var st = loadState(); // 用户上次状态

    /* ---------- 样式（复用网站设计体系） ---------- */
    var css = document.createElement('style');
    css.textContent = [
      /* 主角色容器（全屏视口，只作定位） */
      '#nailong-assist{position:fixed; inset:0; z-index:99999; pointer-events:none; user-select:none;}',
      /* 角色本体 */
      '#nailong-assist .nailong-char{position:absolute; width:110px; height:110px; cursor:grab; pointer-events:auto; transition:left 0.5s ease, top 0.5s ease; touch-action:none;}',
      '#nailong-assist .nailong-char:active{cursor:grabbing;}',
      '#nailong-assist .nailong-char img{width:100%; height:100%; object-fit:contain; filter:drop-shadow(0 4px 6px rgba(0,0,0,0.25)); -webkit-user-drag:none; user-select:none;}',
      /* 对话气泡（初始隐藏） */
      '#nailong-assist .nailong-bubble{position:absolute; width:200px; background:#fff; border:2px solid #f5c542; border-radius:14px; padding:10px 12px; font-size:13px; color:#333; pointer-events:auto; box-shadow:0 6px 18px rgba(0,0,0,0.2); display:none;}',
      '#nailong-assist .nailong-bubble:after{content:""; position:absolute; bottom:-10px; left:50%; border-width:10px 8px 0; border-style:solid; border-color:#f5c542 transparent transparent;}',
      /* 聊天窗口 */
      '#nailong-chat{position:fixed; right:24px; bottom:24px; width:340px; max-width:calc(100vw - 48px); background:#fff; border-radius:18px; box-shadow:0 12px 40px rgba(0,0,0,0.25); z-index:100000; display:none; flex-direction:column; overflow:hidden;}',
      '.chat-header{background:#f5c542; color:#5a4a00; padding:12px 16px; font-weight:800; font-size:15px; display:flex; justify-content:space-between; align-items:center;}',
      '.chat-close{cursor:pointer; font-size:18px; line-height:1;}',
      '.chat-body{height:300px; overflow-y:auto; padding:12px; background:#fdf9ec; display:flex; flex-direction:column; gap:8px;}',
      '.chat-msg{max-width:85%; padding:8px 12px; border-radius:12px; font-size:13.5px; line-height:1.6;}',
      '.chat-msg.user{align-self:flex-end; background:#f5c542; color:#3c3200;}',
      '.chat-msg.ai{align-self:flex-start; background:#fff; border:1px solid #eee; color:#333;}',
      '.chat-msg.err{background:#fdecea; color:#c0392b;}',
      '.chat-input-row{display:flex; padding:10px; gap:8px; background:#fff; border-top:1px solid #f0e6c8;}',
      '.chat-input{flex:1; border:1px solid #ddd; border-radius:10px; padding:9px 12px; font-size:14px; outline:none;}',
      '.chat-send{background:#f5c542; border:none; border-radius:10px; padding:0 18px; font-size:14px; font-weight:700; cursor:pointer; color:#5a4a00;}',
      /* 右键菜单（复用气泡风格） */
      '#nailong-ctx{position:fixed; z-index:100001; background:#fff; border:1px solid #eee; border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,0.22); padding:6px; min-width:140px; display:none;}',
      '#nailong-ctx .ctx-item{padding:9px 14px; font-size:13.5px; color:#333; cursor:pointer; border-radius:8px; display:flex; justify-content:space-between; gap:18px;}',
      '#nailong-ctx .ctx-item:hover{background:#fdf3d8;}',
      '#nailong-ctx .ctx-item .ctx-check{color:#c9a227; font-weight:800;}',
      /* 隐藏后的小图标入口 */
      '#nailong-mini{position:fixed; right:20px; bottom:20px; width:52px; height:52px; border-radius:50%; background:#f5c542; box-shadow:0 6px 18px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:99998; pointer-events:auto; font-size:22px; color:#5a4a00;}',
      '#nailong-mini:hover{transform:scale(1.08);}',
    ].join('');
    document.head.append(css);

    /* ---------- DOM ---------- */
    var wrap = document.createElement('div');
    wrap.id = 'nailong-assist';
    wrap.innerHTML =
      '<div class="nailong-char" id="nailongChar"><img id="nailongImg" alt="奶龙" src="/js/nailong/pose1.png"></div>' +
      '<div class="nailong-bubble" id="nailongBubble">你好呀~ 我是奶龙，点击我聊天吧！</div>';

    var chatBox = document.createElement('div');
    chatBox.id = 'nailong-chat';
    chatBox.innerHTML =
      '<div class="chat-header"><span>奶龙助手</span><span class="chat-close" id="chatClose">×</span></div>' +
      '<div class="chat-body" id="chatBody"></div>' +
      '<div class="chat-input-row"><input class="chat-input" id="chatInput" placeholder="问我竞赛、资源、组队..."><button class="chat-send" id="chatSend">发送</button></div>';

    // 右键菜单
    var ctx = document.createElement('div');
    ctx.id = 'nailong-ctx';
    ctx.innerHTML =
      '<div class="ctx-item" id="ctxWalk"><span>走动</span><span class="ctx-check" id="ctxWalkCheck" style="display:none">✓</span></div>' +
      '<div class="ctx-item" id="ctxHide"><span>隐藏</span><span class="ctx-check" id="ctxHideCheck" style="display:none">✓</span></div>';

    // 隐藏后的小图标
    var mini = document.createElement('div');
    mini.id = 'nailong-mini';
    mini.textContent = '🐤';
    mini.style.display = 'none';

    document.body.append(wrap);
    document.body.append(chatBox);
    document.body.append(ctx);
    document.body.append(mini);

    var char = document.getElementById('nailongChar');
    var img = document.getElementById('nailongImg');
    var bubble = document.getElementById('nailongBubble');
    var POSES = [];
    for (var i = 1; i <= 13; i++) POSES.push('/js/nailong/pose' + i + '.png');

    /* ---------- 走动逻辑 ---------- */
    var CH_SIZE = 110;
    var AREA = {
      minX: 16,
      maxX: function () { return Math.max(16, window.innerWidth - CH_SIZE - 16); },
      minY: 90,
      maxY: function () { return Math.max(120, window.innerHeight - CH_SIZE - 16); }
    };
    // 记住拖拽位置（localStorage）
    var savedPos = null;
    try {
      var sp = localStorage.getItem('nailong_pos');
      if (sp) savedPos = JSON.parse(sp);
    } catch (e) { }

    // 初始位置：有记忆则用记忆位置（走动状态也以记忆为中心），否则右下角
    var px = savedPos ? savedPos.x : Math.max(16, window.innerWidth - CH_SIZE - 30);
    var py = savedPos ? savedPos.y : Math.max(90, window.innerHeight - CH_SIZE - 40);
    var targetX = px, targetY = py;
    var walking = st.walking; // 用户状态

    function clampPos(x, y) {
      return {
        x: Math.min(Math.max(16, x), window.innerWidth - CH_SIZE - 16),
        y: Math.min(Math.max(90, y), window.innerHeight - CH_SIZE - 16)
      };
    }
    function savePos() {
      try { localStorage.setItem('nailong_pos', JSON.stringify({ x: Math.round(px), y: Math.round(py) })); } catch (e) { }
    }

    function pickTarget() {
      var mx = AREA.maxX(), my = AREA.maxY();
      targetX = AREA.minX + Math.random() * (mx - AREA.minX);
      targetY = AREA.minY + Math.random() * (my - AREA.minY);
    }
    pickTarget();

    char.style.left = px + 'px';
    char.style.top = py + 'px';
    char.style.opacity = '1';
    char.style.visibility = 'visible';

    setInterval(function () {
      if (!walking) return;
      var dx = targetX - px, dy = targetY - py;
      var dist = Math.hypot(dx, dy);
      if (dist < 8) { pickTarget(); }
      px += dx * 0.03; py += dy * 0.03;
      char.style.left = px + 'px';
      char.style.top = py + 'px';
    }, 60);

    /* ---------- 拖拽（固定状态可拖动；Pointer Events；无长按） ---------- */
    var dragState = { dragging: false, moved: false, pointerId: -1, startX: 0, startY: 0, origX: 0, origY: 0 };

    function onDragStart(e) {
      if (walking) return; // 仅固定状态可拖
      dragState.dragging = true;
      dragState.moved = false;
      dragState.pointerId = e.pointerId;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;
      dragState.origX = px;
      dragState.origY = py;
      char.style.transition = 'none'; // 拖拽中禁动画
      try { char.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
    }

    function onDragMove(e) {
      if (!dragState.dragging || e.pointerId !== dragState.pointerId) return;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragState.moved = true;
      if (dragState.moved) {
        var np = clampPos(dragState.origX + dx, dragState.origY + dy);
        px = np.x; py = np.y;
        targetX = px; targetY = py;
        char.style.left = px + 'px';
        char.style.top = py + 'px';
      }
    }

    function onDragEnd() {
      if (!dragState.dragging) return;
      dragState.dragging = false;
      char.style.transition = '';
      if (dragState.moved) savePos();
    }

    char.addEventListener('pointerdown', onDragStart);
    char.addEventListener('pointermove', onDragMove);
    char.addEventListener('pointerup', onDragEnd);
    char.addEventListener('pointercancel', onDragEnd);

    /* ---------- 动作切换（10秒换一张） ---------- */
    var poseIdx = 0;
    setInterval(function () {
      poseIdx = (poseIdx + 1) % POSES.length;
      img.src = POSES[poseIdx];
    }, 10000);

    /* ---------- 弹窗对话 ---------- */
    var chatVisible = false;
    var chatHistory = [];

    function showChat() {
      chatVisible = true;
      chatBox.style.display = 'flex';
      bubble.style.display = 'none';
      ctx.style.display = 'none';
      if (!chatBody.children.length) {
        addMsg('ai', '你好呀~ 我是奶龙！关于竞赛、学习资源、组队、协会的事都可以问我哦，也可以说"带我去竞赛中心"~');
      }
    }
    function hideChat() {
      chatVisible = false;
      chatBox.style.display = 'none';
    }

    char.addEventListener('click', function () {
      // 刚拖动过（或正在拖动）则不算点击，不弹聊天
      if (dragState.moved || dragState.dragging) return;
      chatVisible ? hideChat() : showChat();
    });
    document.getElementById('chatClose').addEventListener('click', hideChat);

    /* ---------- 右键菜单 ---------- */
    var ctxWalk = document.getElementById('ctxWalk');
    var ctxHide = document.getElementById('ctxHide');
    var ctxWalkCheck = document.getElementById('ctxWalkCheck');
    var ctxHideCheck = document.getElementById('ctxHideCheck');

    function applyState() {
      // 走动开关
      if (walking) {
        ctxWalkCheck.style.display = 'inline';
      } else {
        ctxWalkCheck.style.display = 'none';
        targetX = px; targetY = py; // 固定：留在原地
      }
      // 显示/隐藏
      if (st.shown) {
        char.style.display = 'block';
        mini.style.display = 'none';
        ctxHideCheck.style.display = 'inline';
      } else {
        char.style.display = 'none';
        bubble.style.display = 'none';
        chatBox.style.display = 'none';
        mini.style.display = 'flex';
        ctxHideCheck.style.display = 'none';
      }
      saveState({ walking: walking, shown: st.shown });
    }

    // 弹出菜单（右键/长按共用）
    function openCtxMenu(cx, cy) {
      var mx = Math.min(cx, window.innerWidth - 170);
      var my = Math.min(cy, window.innerHeight - 120);
      mx = Math.max(8, mx); my = Math.max(8, my);
      ctx.style.left = mx + 'px';
      ctx.style.top = my + 'px';
      ctx.style.display = 'block';
    }

    // 右键奶龙 → 弹出菜单
    char.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation(); // 不冒泡导致关闭
      openCtxMenu(e.clientX, e.clientY);
    });

    // 点击其他地方关闭菜单
    document.addEventListener('click', function () {
      ctx.style.display = 'none';
    });
    document.addEventListener('scroll', function () {
      ctx.style.display = 'none';
    }, { passive: true });

    // 菜单项：走动/固定
    ctxWalk.addEventListener('click', function (e) {
      e.stopPropagation();
      walking = !walking;
      if (walking) pickTarget();
      applyState();
      ctx.style.display = 'none';
    });
    // 菜单项：隐藏/显示
    ctxHide.addEventListener('click', function (e) {
      e.stopPropagation();
      st.shown = !st.shown;
      applyState();
      ctx.style.display = 'none';
    });

    // 小图标：点击恢复奶龙
    mini.addEventListener('click', function (e) {
      e.stopPropagation();
      st.shown = true;
      applyState();
    });

    /* ---------- 对话发送 ---------- */
    var chatBody = document.getElementById('chatBody');
    var chatInput = document.getElementById('chatInput');
    var chatSend = document.getElementById('chatSend');

    function addMsg(role, text) {
      var div = document.createElement('div');
      div.className = 'chat-msg ' + role;
      div.textContent = text;
      chatBody.append(div);
      chatBody.scrollTop = chatBody.scrollHeight;
    }

    /* ---------- 导航指令（本地词库） ---------- */
    var NAV_MAP = [
      { keywords: ['竞赛', '比赛', '电子设计', '计算机设计', '蓝桥杯'], action: function () { window.__czsNav && window.__czsNav('/#competitions'); } },
      { keywords: ['资源', '网盘', '课程', '学习资料'], action: function () { location.href = '/resources.html'; } },
      { keywords: ['组队', '队友', '队伍'], action: function () { window.__czsNav && window.__czsNav('/#team'); } },
      { keywords: ['立项', '经费', '报销', '名单'], action: function () { location.href = '/funding-list.html'; } },
      { keywords: ['首页', '主页'], action: function () { location.href = '/'; } },
      { keywords: ['协会', '简介', '创智算', '方向'], action: function () { window.__czsNav && window.__czsNav('/#about'); } },
    ];
    function tryNav(text) {
      for (var i = 0; i < NAV_MAP.length; i++) {
        if (NAV_MAP[i].keywords.some(function (k) { return text.indexOf(k) >= 0; })) { NAV_MAP[i].action(); return true; }
      }
      return false;
    }

    /* ---------- 发送对话 ---------- */
    async function send() {
      var q = chatInput.value.trim();
      if (!q) return;
      chatInput.value = '';
      addMsg('user', q);
      chatHistory.push({ role: 'user', content: q });

      if (/跳(转|到)|带我去|去.*页面|前往/.test(q)) {
        if (tryNav(q)) {
          setTimeout(function () { addMsg('ai', '好的！这就带你过去~ ⛳'); }, 200);
          chatHistory.push({ role: 'assistant', content: '已导航' });
          return;
        }
      }

      addMsg('ai', '……');
      var loading = chatBody.lastElementChild;
      try {
        var resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, history: chatHistory.slice(-4) }),
        });
        var data = await resp.json();
        if (data.ok) {
          loading.textContent = data.answer.replace(/@@NAV:([^@(]+)\(?(.*?)\)?@@/g, function (m, name, urlPart) {
            var map = { '首页': '/', '竞赛中心': '/#competitions', '学习资源': '/resources.html', '组队大厅': '/#team', '立项名单': '/funding-list.html', '协会简介': '/#about', '方向': '/#fields' };
            var url = map[name.trim()] || (urlPart && urlPart.indexOf('/') === 0 ? urlPart : '/');
            if (url.indexOf('#') >= 0 && (url.split('#')[0] === '' || url.split('#')[0] === '/' || url.split('#')[0] === location.pathname)) {
              var anchor = url.split('#')[1];
              var el = document.getElementById(anchor);
              if (el) { setTimeout(function () { el.scrollIntoView({ behavior: 'smooth' }); }, 600); return '(已经带你到' + name.trim() + '啦~)'; }
            }
            setTimeout(function () { window.location.href = url; }, 600);
            return '(已经带你到' + name.trim() + '啦~)';
          });
          chatHistory.push({ role: 'assistant', content: data.answer });
        } else {
          loading.className = 'chat-msg err';
          loading.textContent = data.msg || '出错了，稍后再试~';
        }
      } catch (e) {
        loading.className = 'chat-msg err';
        loading.textContent = '网络开了小差，稍后再试~';
      }
    }
    chatSend.addEventListener('click', send);
    chatInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    // 应用初始状态
    applyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
