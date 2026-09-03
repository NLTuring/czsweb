// 登录状态组件：在导航栏 #authSlot 位置渲染当前用户（含头像）、缴费状态与登录/退出入口
// 同时维护"加入协会"按钮状态：已缴费 → 显示"已加入协会"
(function(){
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  const css = document.createElement('style');
  css.textContent = [
    '.auth-slot{display:flex; align-items:center; gap:10px; font-family:var(--mono); font-size:12.5px; flex-shrink:0;}',
    '.auth-link{color:var(--forest); opacity:0.85; cursor:pointer; white-space:nowrap; transition:opacity .15s;}',
    '.auth-link:hover{opacity:1; text-decoration:underline; text-underline-offset:3px;}',
    '.auth-user{display:inline-flex; align-items:center; gap:7px; color:var(--forest-deep); font-weight:700; white-space:nowrap;}',
    '.auth-avatar{width:24px; height:24px; border-radius:50%; object-fit:cover; border:1.5px solid var(--forest); background:var(--paper-dim); cursor:pointer; transition:transform .15s;}',
    '.auth-avatar:hover{transform:scale(1.12);}',
    '.auth-paid-tag{font-size:10px; color:var(--copper); border:1px solid var(--copper); padding:1px 8px; border-radius:100px; white-space:nowrap;}',
    '.nav-cta.joined{background:rgba(63,85,65,0.12); color:var(--forest); cursor:default;}',
    '.nav-cta.joined::before{background:var(--signal); box-shadow:0 0 6px var(--signal);}',
  ].join('');
  document.head.append(css);

  function uploadAvatar(){
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if(!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        fetch('/api/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ avatar: String(reader.result) }),
        })
          .then(r => r.json())
          .then(d => {
            if(d && d.ok){ render(); }
            else if(d && d.msg){ alert(d.msg); }
          })
          .catch(() => {});
      };
      reader.readAsDataURL(f);
      input.remove();
    });
    input.click();
  }

  function render(){
    const slot = document.getElementById('authSlot');
    if(!slot) return;
    fetch('/api/me', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : { ok: false }))
      .then(d => {
        window.__czsMe = d;
        // 右上角"加入协会"按钮状态
        const cta = document.querySelector('a.nav-cta');
        if(cta){
          if(d && d.ok && d.paid){
            cta.textContent = '✓ 已加入协会';
            cta.classList.add('joined');
          } else {
            cta.textContent = '加入协会';
            cta.classList.remove('joined');
          }
        }
        if(d && d.ok){
          let avatarHtml = d.avatar
            ? '<img class="auth-avatar" src="' + esc(d.avatar) + '" alt="头像" title="进入个人主页">'
            : '';
          slot.innerHTML =
            '<span class="auth-user" id="authProfileBtn" style="cursor:pointer;" title="进入个人主页">' + avatarHtml + esc(d.name || d.username) + '</span>' +
            (d.paid ? '<span class="auth-paid-tag">已加入协会</span>' : '') +
            (d.isAdmin ? '<a class="auth-link" href="/admin.html">管理</a>' : '') +
            '<a class="auth-link" id="logoutBtn">退出</a>';
          // 点击头像/用户名 → 进入个人主页
          document.getElementById('authProfileBtn').addEventListener('click', () => {
            location.href = '/profile.html';
          });
          document.getElementById('logoutBtn').addEventListener('click', () => {
            fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
              .finally(() => location.href = '/login.html');
          });
        } else {
          slot.innerHTML = '<a class="auth-link" href="/login.html">登录 / 注册</a>';
        }
      })
      .catch(() => {
        slot.innerHTML = '<a class="auth-link" href="/login.html">登录 / 注册</a>';
      });
  }

  window.__czsRefreshAuth = render;

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }

  /* ============================================================
   * 奶龙 AI 助手接入：登录后加载
   * - window.__czsNav(hashUrl)：平滑滚动到指定区块
   * - 加载 nailong-assistant.js（幂等：已加载则跳过）
   * ============================================================ */
  // 导航：支持 /#competition 等锚点平滑滚动，跨页则跳转
  window.__czsNav = function (target) {
    if (target.indexOf('#') >= 0) {
      var path = target.split('#')[0];
      var anchor = target.split('#')[1];
      // 当前页就是目标页 → 滚动画
      if (path === '' || path === '/' || path === location.pathname) {
        var el = document.getElementById(anchor) || document.querySelector('[data-anchor="' + anchor + '"]');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return true;
        }
      }
      // 跨页 → 跳转后自动定位（带 hash 即可，页面加载后浏览器处理）
      location.href = path + '#' + anchor;
      return true;
    }
    location.href = target;
    return true;
  };

  // ============ 奶龙加载条件：登录且已付费（含管理员），未付费时不出 ============
  function canShowNailong() {
    var m = window.__czsMe;
    return !!(m && m.ok && (m.paid || m.isAdmin));
  }

  // 登录且已付费后才加载奶龙
  var __startNailong = function () {
    if (!canShowNailong()) return;
    if (window.__nailongLoaded) return;
    window.__nailongLoaded = true;
    var s = document.createElement('script');
    s.src = '/js/nailong-assistant.js?v=2';
    s.async = true;
    document.head.appendChild(s);
  };

  // 页面加载即预加载奶龙脚本（脚本内部自行判断登录态），彻底消除时序问题
  (function () {
    if (window.__nailongLoaded) return;
    // 先立即尝试一次（若 __czsMe 已就绪）
    if (window.__czsMe && window.__czsMe.ok && (window.__czsMe.paid || window.__czsMe.isAdmin)) {
      __startNailong();
      return;
    }
    // 否则等 __czsMe 建立后再加载（含付费审核通过后刷新场景）
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (window.__czsMe) {
        if (canShowNailong()) {
          clearInterval(t);
          __startNailong();
        } else if (!window.__czsMe.ok || tries > 45) {
          // 已明确未登录 或 超时（含未付费但登录）→ 停止轮询（付费后由 refresh 触发）
          clearInterval(t);
        }
      } else if (tries > 30) {
        clearInterval(t);
      }
    }, 400);
  })();

  // 监听 render 完成后时机（auth-ui 内部设置了 window.__czsMe）
  var __meTimer = setInterval(function () {
    if (window.__czsMe) {
      clearInterval(__meTimer);
      // 只有登录且已付费（或管理员）才加载奶龙；未登录/未付费则不再加载
      if (canShowNailong()) {
        __startNailong();
      }
    }
  }, 300);
  // 兜底：15 秒后仍无登录态则放弃（用户未登录或超时）
  setTimeout(function () { clearInterval(__meTimer); }, 15000);

  // render 完成后即使 timer 已清，也再次尝试加载（防时序竞态；付费审核通过后 __czsRefreshAuth 会触发这里）
  var __origRender = window.__czsRefreshAuth;
  if (typeof __origRender === 'function') {
    var __wrapped = function () {
      __origRender.apply(null, arguments);
      if (canShowNailong()) {
        __startNailong();
      }
    };
    window.__czsRefreshAuth = __wrapped;
  }
})();
