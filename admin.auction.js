
/* 匿名拍卖 · 后台管理（2026-11-10 纯增量）
   ⚠️ 所有管理操作统一走 auction_admin(p_pass, p_action, p_payload)；
      口令只存在内存变量 _aucPass，不写 localStorage、不写进页面源码、刷新即失效。
   ⚠️ 导入排表复用 saveDataToSupabase() 主保存链路
      （按 item_id 自动对齐 / 服务端 409 护栏 / 删除墓碑 全在链路上），不新开写库路径。 */
var _aucPass = '', _aucItems = [], _aucWinners = [], _aucTabNow = 'setup', _aucBusy = false;
/* v2：_aucSchemaOk 未确认前禁止开拍（避免没跑升级 SQL 时图片/开启时间被静默丢掉） */
var _aucSchemaOk = false, _aucImageData = '';

function _aucEsc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function _aucMoney(v){
  var n = Number(v) || 0;
  return '¥' + (Math.round(n * 100) / 100);
}
function _aucSbBase(){
  try { if (typeof SB_ACTIVE_BASE !== 'undefined' && SB_ACTIVE_BASE) return SB_ACTIVE_BASE; } catch (e) {}
  try { return sbPageBase(); } catch (e) { return location.origin + '/sb'; }
}
function _aucSbKey(){
  try { return (typeof SUPABASE_KEY !== 'undefined') ? SUPABASE_KEY : ''; } catch (e) { return ''; }
}
function _aucFetcher(){
  return (typeof sbFetchWithFallback === 'function') ? sbFetchWithFallback : window.fetch;
}
function _aucRpc(fn, body){
  var key = _aucSbKey();
  return _aucFetcher()(_aucSbBase() + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
/* v3（2026-11-10）：管理接口带后台 Supabase 登录凭证，数据库认「已登录的管理」，
   不用再手输一遍管理口令。凭证只在登录后临时从会话读，绝不写进页面源码 /
   localStorage，也不发给团员端接口。没登录时退回匿名 key，由服务端口令兜底。 */
async function _aucSessionToken(){
  try {
    if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.auth) {
      var r = await supabaseClient.auth.getSession();
      var s = r && r.data && r.data.session;
      if (s && s.access_token) return s.access_token;
    }
  } catch (e) {}
  /* 兜底：某些页面把 client 关在闭包里时，从 supabase-js 的会话键里取。
     取到过期凭证也没关系 —— 服务端验不过会自动回退到口令框。 */
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || !/^sb-.*-auth-token$/.test(k)) continue;
      var j = JSON.parse(localStorage.getItem(k) || '{}');
      if (j && j.access_token) return j.access_token;
    }
  } catch (e) {}
  return '';
}
async function _aucAdmRpc(fn, body){
  var key = _aucSbKey();
  var tok = await _aucSessionToken();
  return _aucFetcher()(_aucSbBase() + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + (tok || key),
               'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
function _aucRelock(msg){
  _aucPass = '';
  _aucAutoOk = false;
  var box = document.getElementById('aucPassBox');
  var main = document.getElementById('aucMain');
  if (box) box.style.display = 'block';
  if (main) main.style.display = 'none';
  _aucMsg('aucPassMsg', msg || '口令不对', true);
  var hint = document.getElementById('aucAuthHint');
  if (hint) hint.textContent = '登录状态已失效，请用口令或重新登录后台';
}
function _aucAdm(action, payload){
  return _aucAdmRpc('auction_admin', {
    p_pass: _aucPass, p_action: action, p_payload: payload || {}
  }).then(function (r) {
    if (r && r.ok === false && /口令/.test(String(r.msg || ''))) _aucRelock(r.msg);
    return r;
  });
}
function _aucMsg(id, text, bad){
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.style.color = bad ? '#b91c1c' : '#15803d';
}
/* ===== v2 · 图片压缩 / 版本探测 / 时间换算 ===== */
function _aucToIso(v){
  var s = String(v || '').trim().replace(' ', 'T');
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00';
  var d = new Date(s + '+08:00');
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
function _aucSafeImg(s){
  var v = String(s == null ? '' : s);
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return v;
  if (/^https:\/\//i.test(v)) return v;
  return '';
}
function _aucPhase(it){
  var now = Date.now();
  if (it.status === 'ended' || (it.ends_at && new Date(it.ends_at).getTime() <= now)) return 'ended';
  if (it.starts_at && new Date(it.starts_at).getTime() > now) return 'soon';
  return 'live';
}
function _aucSetSchema(ok){
  _aucSchemaOk = !!ok;
  var box = document.getElementById('aucSchemaMsg');
  var btn = document.querySelector('#aucForm button[type="submit"]');
  if (box) {
    box.style.display = ok ? 'none' : 'block';
    box.innerHTML = ok ? '' :
      '⚠️ 数据库还没升级到 v2，现在开拍会丢掉图片和开启时间。<br>' +
      '请先让维护者在 Supabase SQL Editor 跑一次 <b>auction_upgrade_v2_READY_20261110.sql</b>' +
      '（两个项目各一次），跑完刷新本页再开拍。';
  }
  if (btn) btn.disabled = !ok;
}
async function _aucCheckSchema(){
  try {
    var r = await _aucAdm('schema');
    _aucSetSchema(r && r.ok === true && r.v === 2 && r.image === true && r.starts === true);
  } catch (e) { _aucSetSchema(false); }
}
function _aucImgStatus(text, bad){
  var el = document.getElementById('aucImgMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = bad ? '#b91c1c' : 'var(--c-text-sub)';
}
function aucImgRemove(){
  _aucImageData = '';
  var f = document.getElementById('aucImgFile'); if (f) f.value = '';
  var p = document.getElementById('aucImgPreview');
  if (p) { p.style.display = 'none'; p.removeAttribute('src'); }
  var d = document.getElementById('aucImgDel'); if (d) d.style.display = 'none';
  _aucImgStatus('不传也能开拍；大图会自动压小，不会拖慢手机', false);
}
function aucPickImg(){
  var f = document.getElementById('aucImgFile'); if (f) f.click();
}
/* 只收 jpg/png/webp，原图 ≤10MB；canvas 重编码成白底 JPEG，最长边 900px 起，
   循环降质/缩边把 dataURL 压到 120KB 字符以内（约 90KB 二进制）。
   输出永远是 data:image/jpeg;base64,... —— 不会把用户文件里的脚本带进页面。 */
function _aucCompress(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onerror = function(){ reject(new Error('读不了这张图')); };
    reader.onload = function(ev){
      var img = new Image();
      img.onerror = function(){ reject(new Error('这张图打不开')); };
      img.onload = function(){
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) { reject(new Error('这张图尺寸不对')); return; }
        var side = 900, q = 0.72, n = 0, out = '';
        function draw(){
          var s = Math.min(1, side / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
          var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
          var cx = cv.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
          cx.drawImage(img, 0, 0, cw, ch);
          return cv.toDataURL('image/jpeg', q);
        }
        out = draw();
        while (out.length > 120000 && n < 8) {
          n++;
          if (n % 2 === 1) q = Math.max(0.42, q - 0.08);
          else side = Math.max(420, Math.round(side * 0.8));
          out = draw();
        }
        if (!/^data:image\/jpeg;base64,/.test(out)) { reject(new Error('压缩没成功')); return; }
        resolve(out);
      };
      img.src = ev.target && ev.target.result ? ev.target.result : '';
    };
    reader.readAsDataURL(file);
  });
}
async function aucImgPicked(ev){
  var f = ev && ev.target && ev.target.files ? ev.target.files[0] : null;
  if (!f) return;
  var ext = String(f.name || '').split('.').pop().toLowerCase();
  if (!/^(jpg|jpeg|png|webp)$/.test(ext)) { _aucImgStatus('只支持 jpg / png / webp', true); return; }
  if (f.size > 10 * 1024 * 1024) { _aucImgStatus('原图不能超过 10MB，这张太大了', true); return; }
  _aucImgStatus('正在压小这张图…', false);
  try {
    var data = await _aucCompress(f);
    _aucImageData = data;
    var p = document.getElementById('aucImgPreview');
    if (p) { p.src = data; p.style.display = 'block'; }
    var d = document.getElementById('aucImgDel'); if (d) d.style.display = 'inline-block';
    _aucImgStatus('已就绪（约 ' + Math.round(data.length * 3 / 4 / 1024) + 'KB），点「开拍」一起存上去', false);
  } catch (e) {
    _aucImageData = '';
    _aucImgStatus('这张图没读出来，换一张试试（' + (e && e.message ? e.message : '') + '）', true);
  }
}
function _aucBeijing(iso){
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch (e) { return String(iso); }
}
function _aucDay(iso){
  if (!iso) return '';
  try {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(iso));
    var o = {};
    parts.forEach(function (x) { o[x.type] = x.value; });
    return o.year && o.month && o.day ? (o.year + '-' + o.month + '-' + o.day) : '';
  } catch (e) { return ''; }
}

var _aucAutoOk = false;
function _aucShowPass(show, msg){
  var box = document.getElementById('aucPassBox');
  var main = document.getElementById('aucMain');
  if (box) box.style.display = show ? 'block' : 'none';
  if (show && main) main.style.display = 'none';
  if (!show && main) main.style.display = 'block';
  if (msg) _aucMsg('aucPassMsg', msg, true);
  var hint = document.getElementById('aucAuthHint');
  if (hint) hint.textContent = show
    ? '后台未登录，可用管理口令应急'
    : '已用后台登录身份，刷新无需重输';
}
async function _aucAutoUnlock(){
  _aucAutoOk = false;
  var tok = await _aucSessionToken();
  if (!tok) { _aucShowPass(true); return; }   // 没登录后台 → 口令应急框
  var box = document.getElementById('aucPassBox');
  if (box) box.style.display = 'none';        // 已登录则不闪出口令框
  try {
    var r = await _aucAdmRpc('auction_admin',
      { p_pass: '', p_action: 'state', p_payload: {} });
    if (!r || r.ok !== true) {
      _aucShowPass(true, (r && r.msg) || '后台登录身份未通过');
      return;
    }
    _aucPass = '';                            // 内存里不放任何口令
    _aucShowPass(false);
    _aucMsg('aucPassMsg', '');
    _aucAutoOk = true;
    await _aucCheckSchema();
    _aucItems = r.items || [];
    aucRenderItems();
    aucRenderReal();
    aucAdminTab(_aucTabNow);
  } catch (e) {
    _aucShowPass(true, '没连上数据库，再试一次');
  }
}
async function aucAdminOpen(){
  var m = document.getElementById('aucAdminModal');
  if (m) m.classList.add('active');
  if (_aucPass) { await aucLoadState(); return; }
  await _aucAutoUnlock();
}
function aucAdminClose(){
  var m = document.getElementById('aucAdminModal');
  if (m) m.classList.remove('active');
}
async function aucAdminUnlock(){
  var el = document.getElementById('aucPass');
  var v = el ? String(el.value || '').trim() : '';
  if (!v) { _aucMsg('aucPassMsg', '请先输入管理口令', true); return; }
  _aucPass = v;
  _aucMsg('aucPassMsg', '正在核对…');
  try {
    var r = await _aucAdm('state');
    if (!r || r.ok !== true) { _aucRelock((r && r.msg) || '口令不对'); return; }
    if (el) el.value = '';
    _aucMsg('aucPassMsg', '');
    var box = document.getElementById('aucPassBox');
    var main = document.getElementById('aucMain');
    if (box) box.style.display = 'none';
    if (main) main.style.display = 'block';
    await _aucCheckSchema();
    _aucItems = r.items || [];
    aucRenderItems();
    aucRenderReal();
    aucAdminTab(_aucTabNow);
    var hint = document.getElementById('aucAuthHint');
    if (hint) hint.textContent = '本次用管理口令解锁，刷新后需重新登录';
  } catch (e) {
    _aucRelock('没连上数据库，再试一次');
  }
}
function aucAdminTab(t){
  _aucTabNow = t;
  var s = document.getElementById('aucPaneSetup');
  var w = document.getElementById('aucPaneWinners');
  var a = document.getElementById('aucTabSetupBtn');
  var b = document.getElementById('aucTabWinBtn');
  if (s) s.style.display = (t === 'setup') ? 'block' : 'none';
  if (w) w.style.display = (t === 'winners') ? 'block' : 'none';
  if (a) a.className = 'btn ' + (t === 'setup' ? 'btn-primary' : 'btn-secondary');
  if (b) b.className = 'btn ' + (t === 'winners' ? 'btn-primary' : 'btn-secondary');
  if (t === 'winners') aucLoadWinners();
}
async function aucLoadState(){
  try {
    var r = await _aucAdm('state');
    if (!r || r.ok !== true) { _aucMsg('aucFormMsg', (r && r.msg) || '读取失败', true); return; }
    _aucItems = r.items || [];
    aucRenderItems();
    aucRenderReal();
  } catch (e) { _aucMsg('aucFormMsg', '没连上数据库，再试一次', true); }
}
/* 🔴 2026-11-11 团长指出：bid_count 是「出价次数」，不是「几个人」。
   以前直接写成「X 人已出价」→ 两个人各出三次就显示成「6 人」，看着像六个人在抢。
   现在：人数按圈名去重算（后台接口带 bids 才拿得到），次数单独报，两个都写清楚。 */
function _aucBidStat(it){
  var n = Number(it.bid_count) || 0;
  if (!n) return '还没人出价';
  var seen = {}, ppl = 0;
  (it.bids || []).forEach(function (b) {
    var k = String((b && b.cn) || '').trim();
    if (k && !seen[k]) { seen[k] = 1; ppl++; }
  });
  if (ppl > 0) return ppl + ' 人出价（共 ' + n + ' 次）';
  return '共 ' + n + ' 次出价';        // 明细没取到时退化成只报次数，不能说成「人」
}
function aucRenderItems(){
  var box = document.getElementById('aucItemList');
  if (!box) return;
  if (!_aucItems.length) {
    box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--c-text-sub);font-size:13px;">还没有拍品，填上面的表单开拍</div>';
    return;
  }
  var h = '';
  _aucItems.forEach(function (it, i) {
    var phase = _aucPhase(it), ended = phase === 'ended';
    var img = _aucSafeImg(it.image_data);
    h += '<div style="border:1px solid rgba(0,0,0,.1);border-radius:10px;padding:12px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start;">';
    if (img) h += '<img src="' + _aucEsc(img) + '" alt="拍品图" style="width:76px;height:76px;object-fit:cover;flex:none;border-radius:8px;border:1px solid rgba(0,0,0,.1);">';
    h += '<div style="flex:1;min-width:0;">';
    h += '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
         '<div style="font-weight:700;">' + _aucEsc(it.title) +
         '<span style="font-size:11px;color:var(--c-text-sub);font-weight:400;margin-left:6px;">' + _aucEsc(it.code) + '</span></div>' +
         '<span style="font-size:11px;color:var(--c-text-sub);">' +
         (phase === 'soon' ? '未开始' : ended ? '已结束' : '进行中') + '</span></div>';
    h += '<div style="font-size:12px;color:var(--c-text-sub);margin-top:6px;line-height:1.8;">起拍 ' +
         _aucMoney(it.start_price) + ' · 建议加 ' + _aucMoney(it.step_price) +
         (it.starts_at ? ' · 开拍 ' + _aucBeijing(it.starts_at) : '') +
         ' · 截止 ' + _aucBeijing(it.ends_at) + '（北京时间）</div>';
    h += '<div style="font-size:13px;margin-top:4px;">当前最高 ' +
         _aucMoney(it.highest == null ? it.start_price : it.highest) +
         ' · ' + _aucBidStat(it) + '</div>';
    h += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">';
    if (!ended) h += '<button class="btn btn-secondary" type="button" onclick="aucEndItem(' + i + ')">结束本件</button>';
    h += '<button class="btn btn-danger" type="button" onclick="aucDelItem(' + i + ')">删除本件</button></div>';
    h += '</div></div>';
  });
  box.innerHTML = h;
}
function aucToggleReal(){
  var b = document.getElementById('aucRealBox');
  if (!b) return;
  b.style.display = (b.style.display === 'none' || !b.style.display) ? 'block' : 'none';
  if (b.style.display === 'block') aucRenderReal();
}
function aucRenderReal(){
  var box = document.getElementById('aucRealBox');
  if (!box) return;
  var devs = {};
  _aucItems.forEach(function (it) {
    (it.bids || []).forEach(function (b) {
      var d = String(b.device || '');
      if (!d) return;
      if (!devs[d]) devs[d] = {};
      devs[d][String(b.cn)] = 1;
    });
  });
  var risky = {};
  Object.keys(devs).forEach(function (d) {
    if (Object.keys(devs[d]).length > 1) risky[d] = 1;
  });
  var h = '<div style="font-size:12px;color:var(--c-text-sub);margin-bottom:8px;">这份列表只在后台可见，团员端看不到</div>';
  var any = false;
  _aucItems.forEach(function (it) {
    var bs = it.bids || [];
    if (!bs.length) return;
    any = true;
    h += '<div style="border:1px solid rgba(0,0,0,.1);border-radius:10px;padding:12px;margin-bottom:10px;">' +
         '<div style="font-weight:700;margin-bottom:8px;">' + _aucEsc(it.title) + '</div>' +
         '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>' +
         '<th style="text-align:left;padding:6px 4px;">圈名 CN</th>' +
         '<th style="text-align:left;padding:6px 4px;">出价金额</th>' +
         '<th style="text-align:left;padding:6px 4px;">出价时间</th>' +
         '<th style="text-align:left;padding:6px 4px;">设备编号</th></tr></thead><tbody>';
    bs.forEach(function (b) {
      var flag = risky[String(b.device || '')];
      h += '<tr style="border-top:1px solid rgba(0,0,0,.06);' + (flag ? 'background:#fff1f2;' : '') + '">' +
           '<td style="padding:6px 4px;">' + _aucEsc(b.cn) + (flag ? ' ⚠' : '') + '</td>' +
           '<td style="padding:6px 4px;">' + _aucMoney(b.amount) + '</td>' +
           '<td style="padding:6px 4px;">' + _aucBeijing(b.at) + '</td>' +
           '<td style="padding:6px 4px;font-size:11px;word-break:break-all;">' + _aucEsc(String(b.device || '').slice(0, 20)) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  });
  if (!any) h += '<div style="padding:18px;text-align:center;color:var(--c-text-sub);font-size:13px;">还没有人出价</div>';
  if (Object.keys(risky).length) {
    h += '<div style="font-size:12px;color:#b91c1c;">⚠ 同一台设备用过多个圈名出价（列表里高亮标记）</div>';
  }
  box.innerHTML = h;
}
async function aucOpenItem(){
  if (_aucBusy) return;
  if (!_aucSchemaOk) {
    _aucMsg('aucFormMsg', '数据库还没升级到 v2，请先跑升级 SQL 再开拍', true); return;
  }
  var g = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };
  var title = g('aucTitle'), code = g('aucCode'), sp = g('aucStart'),
      st = g('aucStep'), end = g('aucEnd'), note = g('aucNote'), startAt = g('aucStartAt');
  if (!title || !sp || !end) { _aucMsg('aucFormMsg', '拍品名称、起拍价、截止时间都要填', true); return; }
  /* 2026-11-10 自由出价：加价档位取消，这个数只是「建议加价」（预填团员出价框），留空按 1 元 */
  var spN = Number(sp), stN = st === '' ? 1 : Math.round(Number(st));
  if (!(spN >= 0) || !(stN >= 1)) { _aucMsg('aucFormMsg', '起拍价要填有效数字，建议加价至少 1 元（或留空）', true); return; }
  var endIso = _aucToIso(end);
  if (!endIso) { _aucMsg('aucFormMsg', '截止时间格式不对', true); return; }
  var startIso = '';
  if (startAt) {
    startIso = _aucToIso(startAt);
    if (!startIso) { _aucMsg('aucFormMsg', '开启时间格式不对', true); return; }
    if (Date.parse(startIso) >= Date.parse(endIso)) {
      _aucMsg('aucFormMsg', '开启时间要早于截止时间', true); return;
    }
    if (Date.parse(startIso) <= Date.now()) startIso = '';   // 填了过去的时间 = 立刻开拍
  }
  _aucBusy = true;
  _aucMsg('aucFormMsg', '正在开拍…');
  try {
    var r = await _aucAdm('open', {
      title: title, code: code, start_price: spN, step_price: stN,
      ends_at: endIso, starts_at: startIso, note: note, image_data: _aucImageData
    });
    if (r && r.ok) {
      ['aucTitle', 'aucCode', 'aucStart', 'aucStep', 'aucEnd', 'aucNote', 'aucStartAt'].forEach(function (id) {
        var e = document.getElementById(id); if (e) e.value = '';
      });
      aucImgRemove();
      _aucMsg('aucFormMsg', startIso ? '已排定，到点自动开拍' : '已开拍');
      await aucLoadState();
    } else {
      _aucMsg('aucFormMsg', (r && r.msg) || '没开成', true);
    }
  } catch (e) {
    _aucMsg('aucFormMsg', '没连上数据库，再试一次', true);
  } finally { _aucBusy = false; }
}
async function aucEndItem(i){
  var it = _aucItems[i];
  if (!it) return;
  if (!confirm('结束后不能再出价，确定吗？')) return;
  try {
    var r = await _aucAdm('end', { id: it.id });
    if (r && r.ok) { await aucLoadState(); await aucLoadWinners(); }
    else if (typeof showToast === 'function') showToast((r && r.msg) || '没成功');
  } catch (e) { if (typeof showToast === 'function') showToast('没连上数据库，再试一次'); }
}
async function aucDelItem(i){
  var it = _aucItems[i];
  if (!it) return;
  if (!confirm('删除「' + it.title + '」及它的全部出价记录，确定吗？')) return;
  try {
    var r = await _aucAdm('delete', { id: it.id });
    if (r && r.ok) { await aucLoadState(); await aucLoadWinners(); }
    else if (typeof showToast === 'function') showToast((r && r.msg) || '没成功');
  } catch (e) { if (typeof showToast === 'function') showToast('没连上数据库，再试一次'); }
}
async function aucLoadWinners(){
  try {
    var r = await _aucAdm('winners');
    if (!r || r.ok !== true) { _aucMsg('aucImportMsg', (r && r.msg) || '读取失败', true); return; }
    _aucWinners = r.winners || [];
    aucRenderWinners();
  } catch (e) { _aucMsg('aucImportMsg', '没连上数据库，再试一次', true); }
}
function aucRenderWinners(){
  var box = document.getElementById('aucWinnerList');
  var sum = document.getElementById('aucWinnerSum');
  if (!box) return;
  if (!_aucWinners.length) {
    box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--c-text-sub);font-size:13px;">还没有已结束的竞拍</div>';
    if (sum) sum.textContent = '';
    return;
  }
  var h = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>' +
          '<th style="text-align:left;padding:8px 4px;">拍品名称</th>' +
          '<th style="text-align:left;padding:8px 4px;">编号</th>' +
          '<th style="text-align:left;padding:8px 4px;">中标圈名</th>' +
          '<th style="text-align:left;padding:8px 4px;">成交价</th>' +
          '<th style="text-align:left;padding:8px 4px;">出价笔数</th>' +
          '<th style="text-align:left;padding:8px 4px;">截止时间</th></tr></thead><tbody>';
  var total = 0;
  _aucWinners.forEach(function (w) {
    total += Number(w.amount) || 0;
    h += '<tr style="border-top:1px solid rgba(0,0,0,.07);">' +
         '<td style="padding:8px 4px;">' + _aucEsc(w.title) + '</td>' +
         '<td style="padding:8px 4px;">' + _aucEsc(w.code) + '</td>' +
         '<td style="padding:8px 4px;font-weight:700;">' + _aucEsc(w.cn) + '</td>' +
         '<td style="padding:8px 4px;">' + _aucMoney(w.amount) + '</td>' +
         '<td style="padding:8px 4px;">' + (Number(w.bid_count) || 0) + '</td>' +
         '<td style="padding:8px 4px;">' + _aucBeijing(w.ends_at) + '</td></tr>';
  });
  box.innerHTML = h + '</tbody></table>';
  if (sum) sum.textContent = '共 ' + _aucWinners.length + ' 笔成交 · 合计 ' + _aucMoney(total);
}
function aucExport(){
  if (!_aucWinners.length) { if (typeof showToast === 'function') showToast('还没有已结束的竞拍'); return; }
  var byId = {};
  _aucItems.forEach(function (x) { byId[String(x.id)] = x; });
  var rows = [['拍品名称', '编号', '起拍价', '建议加价', '成交价', '中标圈名', '出价笔数', '开始时间', '截止时间']];
  _aucWinners.forEach(function (w) {
    var it = byId[String(w.item_id)] || {};
    rows.push([
      w.title, w.code,
      it.start_price == null ? '' : it.start_price,
      it.step_price == null ? '' : it.step_price,
      w.amount, w.cn, w.bid_count,
      it.created_at ? _aucBeijing(it.created_at) : '',
      _aucBeijing(w.ends_at)
    ]);
  });
  var csv = rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');
  var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '竞拍成交清单_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 2000);
}
async function _aucFreshGroup(){
  var key = _aucSbKey();
  var qk = (typeof CURRENT_QUERY_KEY !== 'undefined' && CURRENT_QUERY_KEY) ? CURRENT_QUERY_KEY : '4goods';
  var r = await _aucFetcher()(_aucSbBase() + '/rest/v1/leader_data?select=group_data&query_key=eq.' + encodeURIComponent(qk), {
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }, cache: 'no-store'
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var rows = await r.json();
  var gd = rows && rows[0] && rows[0].group_data;
  if (typeof gd === 'string') gd = JSON.parse(gd);
  return Array.isArray(gd) ? gd : null;
}
async function aucImport(){
  if (_aucBusy) return;
  var batchEl = document.getElementById('aucBatch');
  var batch = batchEl ? String(batchEl.value || '').trim() : '';
  if (!batch) { _aucMsg('aucImportMsg', '请先填导入到哪个批次', true); return; }
  if (!_aucWinners.length) { _aucMsg('aucImportMsg', '还没有已结束的竞拍', true); return; }
  if (!confirm('确认导入排表\n\n将把 ' + _aucWinners.length + ' 笔成交写入「' + batch +
               '」，单价=成交价、数量=1、状态=未付款\n\n成功后请到「排表管理」核对；已导入过的会自动跳过')) return;
  _aucBusy = true;
  _aucMsg('aucImportMsg', '正在写入…');
  var startLen = -1, added = [];
  try {
    /* ① 先拉服务器最新排表，按固定 item_id 去重（防同一场导两次 / 旧页面重复） */
    var fresh = await _aucFreshGroup();
    var exist = {};
    (fresh || []).forEach(function (x) { if (x && x.item_id) exist[String(x.item_id)] = 1; });
    if (typeof RAW_ITEMS !== 'undefined' && Array.isArray(RAW_ITEMS)) {
      RAW_ITEMS.forEach(function (x) { if (x && x.item_id) exist[String(x.item_id)] = 1; });
    }
    var skipped = 0;
    _aucWinners.forEach(function (w) {
      var id = 'aucwin_' + String(w.item_id);
      if (exist[id]) { skipped++; return; }
      var row = {
        item_id: id,
        name: String(w.title || ''),
        cn: String(w.cn || ''),
        batch_name: batch,
        price: Number(w.amount) || 0,
        quantity: 1,
        country: '',
        status: '未付款',
        image_url: '',
        created_at: new Date().toISOString()
      };
      var day = _aucDay(w.ends_at);
      if (day) row.order_date = day;      /* 没算出来的日期一律不带，不估算 */
      added.push(row);
      exist[id] = 1;
    });
    if (!added.length) {
      _aucMsg('aucImportMsg', '✅ 已导入 0 条，跳过 ' + skipped + ' 条（已导入过）');
      return;
    }
    /* ② 追加后复用主保存链路（自动对齐 / 409 护栏 / 删除墓碑） */
    startLen = RAW_ITEMS.length;
    RAW_ITEMS.push.apply(RAW_ITEMS, added);
    var saved = await saveDataToSupabase();
    /* ③ 回读逐条核对，硬证据才算成功 */
    var after = await _aucFreshGroup();
    var ids = {};
    (after || []).forEach(function (x) { if (x && x.item_id) ids[String(x.item_id)] = x; });
    var missing = added.filter(function (r) { return !ids[r.item_id]; });
    if (saved === false || missing.length) {
      if (startLen >= 0) RAW_ITEMS.splice(startLen);
      _aucMsg('aucImportMsg', '没保存成功，名单没动，再试一次', true);
      return;
    }
    var msg = '✅ 已导入 ' + added.length + ' 条，跳过 ' + skipped + ' 条（已导入过）';
    _aucMsg('aucImportMsg', msg);
    if (typeof showToast === 'function') showToast(msg);
  } catch (e) {
    if (startLen >= 0 && typeof RAW_ITEMS !== 'undefined' && Array.isArray(RAW_ITEMS)) {
      RAW_ITEMS.splice(startLen);
    }
    _aucMsg('aucImportMsg', '没保存成功，名单没动，再试一次', true);
  } finally { _aucBusy = false; }
}
