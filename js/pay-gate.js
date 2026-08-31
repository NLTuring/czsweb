// 社费门禁（真实人工核验版）
// 规则：登录后未缴社费（paid=0）→ 全屏支付悬浮窗遮盖，无法操作任何内容；
//      用户只能：扫码付款 → 上传付款截图 → 提交审核；
//      管理员在 /admin.html 核对微信账单后批准，服务器写入 paid=1 → 悬浮窗解除；
//      页面不存在任何"自确认支付"入口，用户无法自行解锁。
// 缴费成功后弹出欢迎页，可选择图片作为头像。
(function(){
  var STYLE = [
    '.czs-overlay{position:fixed; inset:0; z-index:99990; background:rgba(20,30,22,0.8); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; padding:20px;}',
    '.czs-pay-card{width:100%; max-width:380px; max-height:92vh; overflow-y:auto; background:#fff; border-radius:20px; padding:30px 28px 24px; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,0.4); position:relative;}',
    '.czs-pay-card .pay-tag{display:inline-block; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--paper); background:var(--copper); padding:3px 12px; border-radius:100px; margin-bottom:14px;}',
    '.czs-pay-card h2{font-size:19px; font-weight:800; margin-bottom:6px;}',
    '.czs-pay-card .pay-sub{font-size:13px; color:rgba(27,36,28,0.6); margin-bottom:16px;}',
    '.czs-qr{width:190px; height:190px; margin:0 auto 10px; border:1px solid var(--line); border-radius:12px; display:block; object-fit:cover;}',
    '.czs-pay-tabs{display:flex; gap:8px; justify-content:center; margin-bottom:12px;}',
    '.czs-tab{font-size:12px; padding:6px 18px; border-radius:100px; border:1px solid var(--line); background:transparent; cursor:pointer; color:rgba(27,36,28,0.7); font-family:var(--sans); transition:all .15s;}',
    '.czs-tab:hover{border-color:var(--forest);}',
    '.czs-tab.active{background:var(--forest-deep); color:var(--paper); border-color:var(--forest-deep);}',
    '.czs-pay-card .pay-fee{font-family:var(--mono); font-size:22px; font-weight:800; color:var(--copper); margin-bottom:4px;}',
    '.czs-pay-card .pay-fee small{font-size:12px; color:rgba(27,36,28,0.55); font-weight:400;}',
    '.czs-pay-card .pay-steps{text-align:left; font-size:12.5px; color:rgba(27,36,28,0.65); line-height:2; margin:10px 0 14px; padding:12px 14px; background:var(--paper); border-radius:10px;}',
    '.czs-pay-card .pay-steps b{color:var(--forest-deep);}',
    '.czs-proof-preview{width:150px; height:150px; margin:0 auto 10px; border:1px solid var(--line); border-radius:12px; object-fit:cover; display:block;}',
    '.czs-status-line{font-size:13px; font-weight:700; color:var(--forest-deep); margin-bottom:10px; display:flex; align-items:center; justify-content:center; gap:7px;}',
    '.czs-status-line .spinner{width:14px; height:14px; border-radius:50%; border:2px solid rgba(63,85,65,0.25); border-top-color:var(--forest); animation:czsSpin 0.9s linear infinite; display:inline-block;}',
    '@keyframes czsSpin{to{transform:rotate(360deg);}}',
    '.czs-status-line.rejected{color:#9c4a2f;}',
    '.czs-reject-note{font-size:12px; color:#9c4a2f; background:rgba(185,90,60,0.08); border:1px solid rgba(185,90,60,0.25); border-radius:8px; padding:8px 12px; margin-bottom:12px; line-height:1.6;}',
    '.czs-pay-btn{display:block; width:100%; padding:13px; border:none; border-radius:100px; background:var(--forest-deep); color:var(--paper); font-size:14.5px; font-weight:700; cursor:pointer; transition:transform .15s; margin-top:6px;}',
    '.czs-pay-btn:hover{transform:translateY(-1px);}',
    '.czs-pay-btn:disabled{opacity:0.6; cursor:wait;}',
    '.czs-btn-ghost{display:block; width:100%; padding:11px; border:1px solid var(--line); border-radius:100px; background:transparent; color:rgba(27,36,28,0.7); font-size:13px; cursor:pointer; margin-top:10px;}',
    '.czs-lock-tip{font-family:var(--mono); font-size:10.5px; color:rgba(27,36,28,0.4); margin-top:14px;}',
    '.czs-upload-name{font-family:var(--mono); font-size:11px; color:var(--copper); margin:8px 0 0; word-break:break-all;}',
    /* 欢迎弹窗 */
    '.czs-welcome{position:fixed; inset:0; z-index:99991; background:rgba(20,30,22,0.6); display:flex; align-items:center; justify-content:center; padding:20px;}',
    '.czs-w-card{width:100%; max-width:380px; background:#fff; border-radius:20px; padding:32px 28px; text-align:center; box-shadow:0 24px 70px rgba(0,0,0,0.35);}',
    '.czs-w-card .w-icon{width:56px; height:56px; border-radius:50%; background:var(--signal); margin:0 auto 16px; display:flex; align-items:center; justify-content:center; font-size:26px; box-shadow:0 0 24px rgba(110,231,168,0.6);}',
    '.czs-w-card h2{font-size:20px; font-weight:800; margin-bottom:6px;}',
    '.czs-w-card .w-sub{font-size:13px; color:rgba(27,36,28,0.6); margin-bottom:20px; line-height:1.7;}',
    '.czs-avatar-wrap{position:relative; width:84px; height:84px; margin:0 auto 14px;}',
    '.czs-avatar-wrap img{width:84px; height:84px; border-radius:50%; object-fit:cover; border:2px solid var(--forest); background:var(--paper-dim);}',
    '.czs-avatar-wrap .av-default{width:84px; height:84px; border-radius:50%; background:var(--forest); color:#fff; display:flex; align-items:center; justify-content:center; font-size:26px; font-weight:700; border:2px solid var(--forest);}',
    '.czs-avatar-edit{position:absolute; right:-4px; bottom:2px; width:26px; height:26px; border-radius:50%; background:var(--copper); color:#fff; border:2px solid #fff; font-size:13px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center;}',
    '.czs-avatar-tip{font-size:11.5px; color:rgba(27,36,28,0.5); margin-bottom:16px;}',
    '.czs-w-btn{display:block; width:100%; padding:13px; border:none; border-radius:100px; background:var(--forest-deep); color:var(--paper); font-size:14.5px; font-weight:700; cursor:pointer; transition:transform .15s;}',
    '.czs-w-skip{background:none; border:none; color:rgba(27,36,28,0.5); font-size:12px; margin-top:12px; cursor:pointer; text-decoration:underline; text-underline-offset:3px;}',
  ].join('');

  function injectStyles(){
    var s = document.createElement('style');
    s.textContent = STYLE;
    document.head.append(s);
  }

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; });
  }

  function getJSON(url){
    return fetch(url, { credentials: 'same-origin' }).then(function(r){ return r.json(); });
  }
  function postJSON(url, body){
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function(r){ return r.json(); });
  }

  var pollTimer = null;

  function showOverlay(proof){
    var payMethod = 'wx'; // 支付方式：wx 微信 / zfb 支付宝
    var overlay = document.createElement('div');
    overlay.className = 'czs-overlay';
    var card = document.createElement('div');
    card.className = 'czs-pay-card';
    overlay.append(card);
    document.body.append(overlay);
    document.body.style.overflow = 'hidden';

    function header(){
      return '<span class="pay-tag">MEMBERSHIP FEE</span>' +
        '<h2>加入"创智算"数字科技协会</h2>' +
        '<p class="pay-sub">支付社团费用并提交凭证，管理员核对后即可访问全部内容</p>';
    }
    function payName(){ return payMethod === 'zfb' ? '支付宝' : '微信'; }
    function qrBlock(){
      return '<div class="czs-pay-tabs">' +
        '<button class="czs-tab' + (payMethod === 'wx' ? ' active' : '') + '" data-m="wx">微信支付</button>' +
        '<button class="czs-tab' + (payMethod === 'zfb' ? ' active' : '') + '" data-m="zfb">支付宝</button>' +
        '</div>' +
        '<img class="czs-qr" src="' + (payMethod === 'zfb' ? 'zfb.jpg' : 'money.jpg') + '" alt="' + payName() + '收款码">' +
        '<div class="pay-fee">社费 ¥20 <small>/ 学年</small></div>';
    }
    // 支付方式切换（重新渲染当前状态）
    function bindTabs(renderFn){
      var tabs = card.querySelectorAll('.czs-tab');
      if(!tabs.length) return;
      Array.prototype.forEach.call(tabs, function(t){
        t.addEventListener('click', function(){
          if(t.getAttribute('data-m') === payMethod) return;
          payMethod = t.getAttribute('data-m');
          renderFn();
        });
      });
    }

    // 状态 1：未提交凭证 → 展示收款码（可切换微信/支付宝）+ 上传付款截图
    function renderUpload(){
      card.innerHTML = header() + qrBlock() +
        '<div class="pay-steps"><b>加入流程：</b><br>1. 使用' + payName() + '扫一扫上方二维码，支付社费 ¥20<br>2. 打开' + payName() + '账单，截取<b>该笔 ¥20 付款记录</b><br>3. 点击下方按钮上传截图，提交审核<br>4. 管理员核对账单后为你开通权限（无需其他操作）</div>' +
        '<button class="czs-pay-btn" id="czsUpBtn">选择付款截图并提交审核</button>' +
        '<div class="czs-upload-name" id="czsUpName"></div>' +
        '<div class="czs-lock-tip">VERIFICATION REQUIRED · 管理员审核通过前无法访问网站</div>' +
        '<input type="file" id="czsProofFile" accept="image/png,image/jpeg,image/webp" style="display:none;">';
      var fileInput = card.querySelector('#czsProofFile');
      card.querySelector('#czsUpBtn').addEventListener('click', function(){ fileInput.click(); });
      fileInput.addEventListener('change', function(){
        var f = fileInput.files && fileInput.files[0];
        if(!f) return;
        var reader = new FileReader();
        reader.onload = function(){
          var btn = card.querySelector('#czsUpBtn');
          btn.disabled = true;
          btn.textContent = '正在提交…';
          postJSON('/api/pay/submit-proof', { image: String(reader.result) }).then(function(d){
            if(d && d.ok){
              showOverlay({ status: 'PENDING' });
            } else {
              btn.disabled = false;
              btn.textContent = '选择付款截图并提交审核';
              alert(d && d.msg ? d.msg : '提交失败，请重试');
            }
          });
        };
        reader.readAsDataURL(f);
        card.querySelector('#czsUpName').textContent = '已选择：' + f.name;
      });
      bindTabs(renderUpload);
    }

    // 状态 2：待审核 → 展示截图 + 轮询
    function renderPending(){
      var imgHtml = proof.image
        ? '<img class="czs-proof-preview" src="' + esc(proof.image) + '" alt="已提交的付款截图">'
        : '';
      card.innerHTML = header() + imgHtml +
        '<div class="czs-status-line"><span class="spinner"></span>凭证已提交，等待管理员审核…</div>' +
        '<p class="pay-sub" style="margin-bottom:14px;">管理员核对微信账单后会自动为你开通权限，<br>本页面每 3 秒自动刷新状态，请勿关闭。</p>' +
        '<div class="czs-lock-tip">ADMIN REVIEW PENDING · 审核通过前无法访问网站</div>';
      startPolling();
    }

    // 状态 3：被驳回 → 可重新提交
    function renderRejected(){
      card.innerHTML = header() +
        '<div class="czs-status-line rejected">✕ 凭证被驳回</div>' +
        '<div class="czs-reject-note">原因：' + esc(proof.note || '凭证无效') + '</div>' +
        qrBlock() +
        '<button class="czs-pay-btn" id="czsReBtn">重新上传付款截图</button>' +
        '<input type="file" id="czsProofFile2" accept="image/png,image/jpeg,image/webp" style="display:none;">';
      card.querySelector('#czsReBtn').addEventListener('click', function(){ card.querySelector('#czsProofFile2').click(); });
      card.querySelector('#czsProofFile2').addEventListener('change', function(){
        var f = this.files && this.files[0];
        if(!f) return;
        var reader = new FileReader();
        reader.onload = function(){
          postJSON('/api/pay/submit-proof', { image: String(reader.result) }).then(function(d){
            if(d && d.ok) showOverlay({ status: 'PENDING' });
            else alert(d && d.msg ? d.msg : '提交失败，请重试');
          });
        };
        reader.readAsDataURL(f);
      });
      bindTabs(renderRejected);
    }

    function startPolling(){
      if(pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(function(){
        getJSON('/api/pay/status').then(function(d){
          if(d && d.paid){
            clearInterval(pollTimer);
            overlay.remove();
            document.body.style.overflow = '';
            showWelcome();
          } else if(d && d.proof && d.proof.status === 'REJECTED'){
            clearInterval(pollTimer);
            showOverlay({ status: 'REJECTED', note: d.proof.note });
          }
        }).catch(function(){});
      }, 3000);
    }

    if(proof && proof.status === 'PENDING') renderPending();
    else if(proof && proof.status === 'REJECTED') renderRejected();
    else renderUpload();
  }

  function showWelcome(){
    var wrap = document.createElement('div');
    wrap.className = 'czs-welcome';
    wrap.innerHTML =
      '<div class="czs-w-card">' +
        '<div class="w-icon">✓</div>' +
        '<h2>欢迎加入"创智算"数字科技协会！</h2>' +
        '<p class="w-sub">缴费审核已通过，你已成为协会正式成员。<br>选择一个图片作为你的头像吧（可跳过）。</p>' +
        '<div class="czs-avatar-wrap">' +
          '<div class="av-default" id="czsAvBox">' + (window.__czsMe && window.__czsMe.name ? esc(window.__czsMe.name.slice(0,1)) : '友') + '</div>' +
          '<span class="czs-avatar-edit" id="czsAvEdit" title="选择图片作为头像">＋</span>' +
        '</div>' +
        '<p class="czs-avatar-tip">支持 PNG / JPG / WebP，不超过 2MB</p>' +
        '<button class="czs-w-btn" id="czsEnterBtn">进入协会 →</button>' +
        '<button class="czs-w-skip" id="czsSkipBtn">暂不设置头像</button>' +
        '<input type="file" id="czsAvFile" accept="image/png,image/jpeg,image/webp" style="display:none;">' +
      '</div>';
    document.body.append(wrap);

    var fileInput = document.getElementById('czsAvFile');
    document.getElementById('czsAvEdit').addEventListener('click', function(){ fileInput.click(); });
    fileInput.addEventListener('change', function(){
      var f = fileInput.files && fileInput.files[0];
      if(!f) return;
      var reader = new FileReader();
      reader.onload = function(){
        var img = new Image();
        img.onload = function(){
          postJSON('/api/avatar', { avatar: String(reader.result) }).then(function(d){
            if(d && d.ok){
              showAvatarPreview(d.avatar);
              if(window.__czsRefreshAuth) window.__czsRefreshAuth();
            } else {
              alert(d && d.msg ? d.msg : '头像上传失败');
            }
          });
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(f);
    });

    function showAvatarPreview(src){
      var box = document.getElementById('czsAvBox');
      var img = document.createElement('img');
      img.src = src;
      img.alt = '头像';
      box.remove();
      box.parentElement.insertBefore(img, box.parentElement.firstChild);
    }

    function closeWelcome(){
      wrap.remove();
      if(window.__czsRefreshAuth) window.__czsRefreshAuth();
    }
    document.getElementById('czsEnterBtn').addEventListener('click', closeWelcome);
    document.getElementById('czsSkipBtn').addEventListener('click', closeWelcome);
  }

  function init(){
    injectStyles();
    getJSON('/api/me').then(function(me){
      window.__czsMe = me;
      // 管理员账号无需缴费，不显示支付悬浮窗
      if(me && me.ok && !me.paid && !me.isAdmin){
        showOverlay(me.proof || null);
      }
    }).catch(function(){});
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
