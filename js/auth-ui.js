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
            ? '<img class="auth-avatar" src="' + esc(d.avatar) + '" alt="头像" title="点击更换头像">'
            : '';
          slot.innerHTML =
            '<span class="auth-user">' + avatarHtml + esc(d.name || d.username) + '</span>' +
            (d.paid ? '<span class="auth-paid-tag">已加入协会</span>' : '') +
            (d.isAdmin ? '<a class="auth-link" href="/admin.html">管理</a>' : '') +
            '<a class="auth-link" id="logoutBtn">退出</a>';
          const av = slot.querySelector('.auth-avatar');
          if(av) av.addEventListener('click', uploadAvatar);
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
})();
