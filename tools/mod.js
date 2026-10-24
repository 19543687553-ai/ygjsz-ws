(function () {
  'use strict';
  if (window.__YG_MOD__) return;
  window.__YG_MOD__ = true;

  var CFG_KEY = 'yg_mod_cfg_v2';
  var SCRIPT_KEY = 'yg_mod_script_v2';

  var state = {
    speed: 1,
    muted: false,
    clicker: { on: false, set: false, x: 0, y: 0, interval: 120, timer: 0 },
    skipGuide: false,
    rec: { on: false, playing: false, events: [], startAt: 0, loops: 0, timer: 0, idx: 0, runId: 0 },
    timerTask: { on: false, iv: 5, method: '', args: '[]', timer: 0, count: 0 },
    panelOpen: false,
    tab: 'main',
    fab: { x: -1, y: -1 },
    panelPos: { x: -1, y: -1 }
  };

  function $(id) { return document.getElementById(id); }
  function q(sel) { return document.querySelector(sel); }

  function nowStr() {
    var t = new Date();
    return '[' + t.toTimeString().slice(0, 8) + '] ';
  }

  function log(msg, ok) {
    try {
      var box = $('yg-log');
      var text = nowStr() + msg;
      if (box) {
        var line = document.createElement('div');
        line.className = 'yg-log-line' + (ok === false ? ' yg-err' : '');
        line.textContent = text;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
        while (box.childNodes.length > 200) box.removeChild(box.firstChild);
      }
      if (ok === false) console.warn('[YG_MOD] ' + msg);
      else console.log('[YG_MOD] ' + msg);
    } catch (e) {}
  }

  function safe(fn, label) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { log((label || '操作') + '异常: ' + ((e && e.message) || e), false); }
    };
  }

  /* ---------- 配置持久化 ---------- */

  function saveCfg() {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify({
        speed: state.speed,
        muted: state.muted,
        skipGuide: state.skipGuide,
        clicker: { x: state.clicker.x, y: state.clicker.y, set: state.clicker.set, interval: state.clicker.interval },
        tab: state.tab,
        fab: state.fab,
        panelPos: state.panelPos,
        timer: { iv: state.timerTask.iv, method: state.timerTask.method, args: state.timerTask.args }
      }));
    } catch (e) {}
  }

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (!raw) return;
      var c = JSON.parse(raw);
      if (c.speed) state.speed = c.speed;
      if (c.muted) state.muted = c.muted;
      if (c.skipGuide) state.skipGuide = c.skipGuide;
      if (c.clicker) {
        state.clicker.x = c.clicker.x || 0;
        state.clicker.y = c.clicker.y || 0;
        state.clicker.set = !!c.clicker.set;
        state.clicker.interval = c.clicker.interval || 120;
      }
      if (c.tab) state.tab = c.tab;
      if (c.fab) state.fab = c.fab;
      if (c.panelPos) state.panelPos = c.panelPos;
      if (c.timer) {
        state.timerTask.iv = c.timer.iv || 5;
        state.timerTask.method = c.timer.method || '';
        state.timerTask.args = c.timer.args || '[]';
      }
    } catch (e) {}
  }

  /* ---------- cc / 类解析 ---------- */

  function waitCC(cb) {
    if (window.cc && cc.director) return cb();
    var n = 0;
    var t = setInterval(function () {
      n++;
      if (window.cc && cc.director) { clearInterval(t); cb(); }
      else if (n > 600) { clearInterval(t); log('等待 cc 超时（600s）', false); }
    }, 500);
  }

  function bridge() { return window.__GM_BRIDGE__ || null; }

  function resolveClass(name) {
    if (!name) return null;
    var cls = null;
    var br = bridge();
    if (br && br[name]) {
      var bv = br[name];
      if (typeof bv === 'function') cls = bv;
      else if (bv && typeof bv[name] === 'function') cls = bv[name];
      else if (bv && typeof bv === 'object') cls = bv;
    }
    if (!cls) {
      try {
        if (window.cc && cc.js && cc.js.getClassByName) cls = cc.js.getClassByName(name);
      } catch (e) {}
    }
    if (!cls && window.__require) {
      try {
        var m = window.__require(name);
        if (m) {
          if (typeof m === 'function') cls = m;
          else if (typeof m[name] === 'function') cls = m[name];
          else {
            for (var k in m) {
              if (typeof m[k] === 'function' && m[k].name === name) { cls = m[k]; break; }
            }
          }
        }
      } catch (e2) {}
    }
    return cls || null;
  }

  function getIns(cls) {
    if (!cls) return null;
    if (typeof cls !== 'function') {
      if (cls.Ins) return cls.Ins;
      if (cls.instance) return cls.instance;
      return cls;
    }
    try {
      if (cls.Ins) return cls.Ins;
      if (cls.instance) return cls.instance;
      if (typeof cls.getInstance === 'function') return cls.getInstance();
    } catch (e) {}
    return null;
  }

  function classNames(keyword) {
    var out = {};
    try {
      var map = (window.cc && cc.js && cc.js._registeredClassNames) || null;
      if (map) {
        for (var k in map) {
          if (!keyword || k.toLowerCase().indexOf(keyword.toLowerCase()) >= 0) out[k] = 1;
        }
      }
    } catch (e) {}
    var br = bridge();
    if (br) {
      for (var b in br) {
        if (!keyword || b.toLowerCase().indexOf(keyword.toLowerCase()) >= 0) out[b] = 1;
      }
    }
    return Object.keys(out).sort();
  }

  /* ---------- 变速（真实客户端时间缩放） ---------- */

  var speedHooked = false;
  var fps = { frames: 0, last: 0, value: 0, timer: 0 };

  /**
   * 只缩放 cc.director 的 deltaTime：
   * 动画 / Tween / Spine / 粒子 / scheduler 计时都会按倍率真实加快。
   * 服务器 CD、挂机产出、战斗结算是服务端时钟，不受此影响。
   */
  function installSpeedHook() {
    if (speedHooked) return true;
    try {
      if (!window.cc || !cc.director || typeof cc.director.calculateDeltaTime !== 'function') return false;
      var orig = cc.director.calculateDeltaTime;
      cc.director.calculateDeltaTime = function (ts) {
        orig.call(this, ts);
        var m = state.speed;
        if (m && Math.abs(m - 1) > 0.001) this._deltaTime *= m;
      };
      speedHooked = true;
      try { cc.director.getScheduler().setTimeScale(1); } catch (e) {}
      return true;
    } catch (e) {
      log('变速钩子安装失败: ' + e.message, false);
      return false;
    }
  }

  function applySpeed(v, quiet) {
    v = Math.max(0.1, Math.min(10, Number(v) || 1));
    state.speed = v;
    if (!installSpeedHook()) {
      waitCC(function () {
        if (installSpeedHook()) log('变速钩子已就绪，当前 ' + state.speed.toFixed(1) + 'x');
      });
    }
    var el = $('yg-speed-val');
    if (el) el.textContent = v.toFixed(1) + 'x';
    var sl = $('yg-speed');
    if (sl && Math.abs(parseFloat(sl.value) - v) > 0.01) sl.value = String(v);
    if (!quiet) log('本地速度 ' + v.toFixed(1) + 'x（仅客户端）');
    updateStat();
    saveCfg();
  }

  function startFpsMeter() {
    if (fps.timer) return;
    fps.last = Date.now();
    fps.frames = 0;
    var loop = function () { fps.frames++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    fps.timer = setInterval(function () {
      var now = Date.now();
      var dt = now - fps.last;
      if (dt > 0) fps.value = Math.round(fps.frames * 1000 / dt);
      fps.frames = 0;
      fps.last = now;
      updateStat();
    }, 1000);
  }

  function updateStat() {
    var el = $('yg-stat');
    if (!el) return;
    var br = bridge();
    var scene = '';
    try { scene = cc.director.getScene() ? cc.director.getScene().name : ''; } catch (e) {}
    var live = '';
    try {
      var IL = br && br.ItemLO;
      if (IL && IL.store) live = '（在线 ' + IL.store.length + '）';
    } catch (e) {}
    el.textContent = '桥接 ' + (br ? Object.keys(br).length : 0) + ' 项 · cc ' + (window.cc ? '√' : '×') +
      (scene ? ' · ' + scene : '') + ' · ' + fps.value + ' FPS · ' + state.speed.toFixed(1) + 'x · 物品库 ' +
      (window.YG_ITEM_DB ? window.YG_ITEM_DB.length : 0) + live;
  }

  function applyMute(on) {
    state.muted = !!on;
    try {
      cc.audioEngine.setMusicVolume(on ? 0 : 1);
      cc.audioEngine.setEffectsVolume(on ? 0 : 1);
      log(on ? '已静音' : '已取消静音');
    } catch (e) {
      log('静音失败: ' + e.message, false);
    }
    var b = $('yg-mute-btn');
    if (b) { b.textContent = on ? '取消静音' : '静音'; b.className = 'yg-btn' + (on ? ' yg-on' : ''); }
    saveCfg();
  }

  /* ---------- 点击合成 ---------- */

  function fireTap(x, y) {
    var canvas = q('canvas');
    if (!canvas) return;
    var target = document.elementFromPoint(x, y) || canvas;
    try {
      if (window.Touch && window.TouchEvent) {
        var touch = new Touch({
          identifier: 1, target: target,
          clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y
        });
        target.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true,
          touches: [touch], targetTouches: [touch], changedTouches: [touch]
        }));
        setTimeout(function () {
          target.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true, cancelable: true,
            touches: [], targetTouches: [], changedTouches: [touch]
          }));
        }, 30);
      } else {
        ['mousedown', 'mouseup', 'click'].forEach(function (type) {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y, view: window
          }));
        });
      }
    } catch (e) {
      log('点击失败: ' + e.message, false);
      stopClicker();
    }
  }

  /* ---------- 连点器 ---------- */

  function startClicker() {
    if (state.clicker.timer) return;
    if (!state.clicker.set) { log('先设置连点位置', false); return; }
    var iv = Math.max(50, parseInt(($('yg-click-iv') || {}).value, 10) || state.clicker.interval);
    state.clicker.interval = iv;
    state.clicker.timer = setInterval(function () {
      fireTap(state.clicker.x, state.clicker.y);
    }, iv);
    state.clicker.on = true;
    var b = $('yg-click-btn');
    if (b) { b.textContent = '停止连点'; b.className = 'yg-btn yg-on'; }
    log('连点开始，间隔 ' + iv + 'ms');
    saveCfg();
  }

  function stopClicker() {
    if (state.clicker.timer) clearInterval(state.clicker.timer);
    state.clicker.timer = 0;
    state.clicker.on = false;
    var b = $('yg-click-btn');
    if (b) { b.textContent = '开始连点'; b.className = 'yg-btn'; }
  }

  function moveCrosshair(x, y) {
    state.clicker.x = x;
    state.clicker.y = y;
    state.clicker.set = true;
    var c = $('yg-cross');
    if (c) {
      c.style.left = x + 'px';
      c.style.top = y + 'px';
      c.style.display = 'block';
    }
    var lab = $('yg-cross-pos');
    if (lab) lab.textContent = Math.round(x) + ', ' + Math.round(y);
  }

  function pickPosition() {
    var cross = $('yg-cross');
    if (cross) cross.style.display = 'block';
    var mask = document.createElement('div');
    mask.id = 'yg-pick-mask';
    mask.textContent = '点击游戏画面选择连点位置';
    document.body.appendChild(mask);
    setTimeout(function () {
      var done = safe(function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var p = ev.touches ? ev.touches[0] : ev;
        moveCrosshair(p.clientX, p.clientY);
        mask.removeEventListener('touchstart', done, true);
        mask.removeEventListener('mousedown', done, true);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        log('连点位置已设置');
        saveCfg();
      }, '选取位置');
      mask.addEventListener('touchstart', done, true);
      mask.addEventListener('mousedown', done, true);
    }, 50);
  }

  /* ---------- 跳过引导 ---------- */

  function applySkipGuide(on) {
    var did = false;
    var UM = resolveClass('UserCacheMgr');
    var umIns = getIns(UM);
    if (umIns) {
      try {
        var vo = null;
        try { vo = umIns.getGlobalData('DebugerCacheVo'); } catch (e) {}
        if (!vo) {
          var VoCls = resolveClass('DebugerCacheVo');
          vo = VoCls && typeof VoCls === 'function' ? new VoCls() : { skipGuide: 0, showGuideShell: 0, showBattleDebug: 0 };
        }
        vo.skipGuide = on ? 1 : 2;
        umIns.saveGlobalData('DebugerCacheVo', vo);
        did = true;
      } catch (e) {
        log('写入 DebugerCacheVo 失败: ' + e.message, false);
      }
    }
    try {
      var GM = resolveClass('GuideModule');
      var gmIns = getIns(GM);
      if (gmIns && typeof gmIns.switchGuideEnable === 'function') {
        gmIns.switchGuideEnable(!!on);
        did = true;
      }
    } catch (e) {
      log('GuideModule 调用失败: ' + e.message, false);
    }
    if (!did) { log('跳过引导不可用（未找到 UserCacheMgr / GuideModule）', false); return; }
    state.skipGuide = !!on;
    var b = $('yg-guide-btn');
    if (b) {
      b.textContent = on ? '恢复引导' : '跳过引导';
      b.className = 'yg-btn' + (on ? ' yg-on' : '');
    }
    log(on ? '已开启跳过引导（新场景生效）' : '已恢复引导');
    saveCfg();
  }

  /* ---------- 内置 GM 面板 ---------- */

  function gmBundleVer() {
    try {
      var v = cc.settings && cc.settings.bundleVers && cc.settings.bundleVers.gm;
      if (!v && cc.assetManager && cc.assetManager.bundleVers) v = cc.assetManager.bundleVers.gm;
      return v || null;
    } catch (e) { return null; }
  }

  function injectGmScript(cb) {
    var ver = gmBundleVer();
    var src = 'assets/gm/index' + (ver ? '.' + ver : '') + '.js';
    var oldReq = window.__require;
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () {
      if (window.__require !== oldReq && oldReq) {
        try { window.__require = oldReq; } catch (e) {}
      }
      cb(!!resolveClass('GMView'));
    };
    s.onerror = function () { cb(false); };
    document.body.appendChild(s);
    log('注入 GM 脚本: ' + src);
  }

  function loadGmBundle(cb) {
    if (resolveClass('GMView')) return cb(true);
    try {
      if (!window.cc || !cc.assetManager) return injectGmScript(cb);
      var b = cc.assetManager.getBundle('gm');
      if (b) return cb(!!resolveClass('GMView'));
      log('加载 gm 分包…');
      cc.assetManager.loadBundle('gm', function (err) {
        if (!err && resolveClass('GMView')) { log('gm 分包加载成功'); return cb(true); }
        var req = window.require || window.__require;
        if (req) {
          try {
            req('gm/index.js');
            if (resolveClass('GMView')) { log('gm 脚本 require 成功'); return cb(true); }
          } catch (e) {}
        }
        injectGmScript(cb);
      });
    } catch (e) {
      injectGmScript(cb);
    }
  }

  function openBuiltinGM() {
    var layer = 1;
    try {
      var br = bridge();
      if (br && br.UILayerType && typeof br.UILayerType.View === 'number') layer = br.UILayerType.View;
    } catch (e) {}
    var doOpen = safe(function () {
      var br = bridge();
      var UIMgr = (br && br.UIMgr) || resolveClass('UIMgr');
      var ins = getIns(UIMgr);
      if (!ins || typeof ins.open !== 'function') {
        log('UIMgr 不可用，无法打开 GM 面板', false);
        return;
      }
      var cls = resolveClass('GMView') || 'GMView';
      try { ins.open(cls, layer); log('已请求打开内置 GM 面板'); }
      catch (e) { log('打开 GM 面板失败: ' + e.message, false); }
    }, '打开GM面板');
    log('准备打开内置 GM 面板…');
    loadGmBundle(function (ok) {
      if (!ok) { log('gm 分包加载失败（检查资源是否完整）', false); return; }
      doOpen();
    });
  }

  /* ---------- GM 控制台 ---------- */

  var currentName = '';
  var currentClass = null;
  var currentIns = null;

  function setOut(text) {
    var el = $('yg-out');
    if (el) el.textContent = text;
  }

  function preview(v) {
    try {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (typeof v === 'function') return '[function ' + (v.name || '') + ']';
      var s = JSON.stringify(v);
      if (s && s.length > 800) s = s.slice(0, 800) + '…';
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  }

  function methodList() {
    var out = [];
    if (!currentClass) return out;
    if (typeof currentClass !== 'function') {
      Object.getOwnPropertyNames(currentClass).forEach(function (k) {
        try { if (typeof currentClass[k] === 'function') out.push(k); } catch (e) {}
      });
    } else {
      try {
        var proto = currentClass.prototype || {};
        Object.getOwnPropertyNames(proto).forEach(function (k) {
          if (k !== 'constructor' && typeof proto[k] === 'function') out.push(k);
        });
      } catch (e) {}
      try {
        Object.getOwnPropertyNames(currentClass).forEach(function (k) {
          if (['length', 'name', 'prototype', 'Ins', 'instance', 'getInstance'].indexOf(k) >= 0) return;
          try {
            if (typeof currentClass[k] === 'function') out.push('static:' + k);
          } catch (e) {}
        });
      } catch (e) {}
    }
    if (currentIns && typeof currentIns === 'object') {
      try {
        var seenIns = {};
        var protoIns = currentIns;
        var depth = 0;
        while (protoIns && protoIns !== Object.prototype && depth < 6) {
          Object.getOwnPropertyNames(protoIns).forEach(function (k) {
            if (k === 'constructor' || seenIns[k]) return;
            seenIns[k] = 1;
            try { if (typeof currentIns[k] === 'function') out.push(k); } catch (e) {}
          });
          protoIns = Object.getPrototypeOf(protoIns);
          depth++;
        }
      } catch (e) {}
    }
    var seen = {};
    return out.filter(function (m) { if (seen[m]) return false; seen[m] = 1; return true; });
  }

  function selectClass(name, silent) {
    currentName = name || '';
    currentClass = resolveClass(currentName);
    currentIns = currentClass ? getIns(currentClass) : null;
    var sel = $('yg-method');
    var props = $('yg-props');
    if (sel) sel.innerHTML = '';
    if (props) props.textContent = '';
    if (!currentClass) {
      if (!silent) {
        var guess = classNames(currentName).slice(0, 30);
        setOut('✗ 未找到: ' + currentName + (guess.length ? '\n相近: ' + guess.join(', ') : ''));
      }
      return false;
    }
    var list = methodList();
    if (sel) {
      list.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        sel.appendChild(o);
      });
    }
    dumpProps();
    if (!silent) {
      setOut('✓ ' + currentName + (currentIns ? '  [单例]' : '  [无单例]') +
        '\n方法(' + list.length + '): ' + list.slice(0, 60).join(', ') + (list.length > 60 ? ' …' : ''));
    }
    return true;
  }

  function dumpProps() {
    var el = $('yg-props');
    if (!el) return;
    if (!currentIns) { el.textContent = '（无单例实例，仅能调用静态方法）'; return; }
    var lines = [];
    try {
      Object.keys(currentIns).forEach(function (k) {
        var v;
        try { v = currentIns[k]; } catch (e) { return; }
        if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
          lines.push(k + ' = ' + preview(v));
        } else if (typeof v === 'object' && v && !v.node && !v._name) {
          lines.push(k + ' = ' + (Array.isArray(v) ? 'Array(' + v.length + ')' : '{…}'));
        }
        if (lines.length > 60) return;
      });
    } catch (e) {}
    el.textContent = lines.join('\n') || '（无可读属性）';
  }

  function callMethod() {
    var method = (($('yg-method') || {}).value || '').trim();
    var argsText = (($('yg-args') || {}).value || '').trim();
    if (!currentClass) { setOut('先解析一个类'); return; }
    if (!method) { setOut('选择或输入方法名'); return; }
    var args = [];
    if (argsText) {
      try {
        args = JSON.parse(argsText);
        if (!Array.isArray(args)) args = [args];
      } catch (e) {
        setOut('参数必须是 JSON 数组，如 [1,"abc"]');
        return;
      }
    }
    try {
      var isStatic = method.indexOf('static:') === 0;
      if (isStatic) method = method.slice(7);
      var fn;
      var ctx;
      if (isStatic) { fn = currentClass[method]; ctx = currentClass; }
      else { ctx = currentIns || currentClass; fn = ctx[method]; }
      if (typeof fn !== 'function') { setOut('✗ 方法不存在: ' + method); return; }
      var ret = fn.apply(ctx, args);
      setOut('✓ ' + method + ' 已调用\n返回: ' + preview(ret));
      log('调用 ' + currentName + '.' + method);
    } catch (e) {
      setOut('✗ 调用异常: ' + e.message);
      log('调用异常: ' + e.message, false);
    }
  }

  function setProp() {
    var k = (($('yg-prop-k') || {}).value || '').trim();
    var raw = (($('yg-prop-v') || {}).value || '').trim();
    if (!currentIns) { setOut('当前类没有单例实例'); return; }
    if (!k) { setOut('填写属性名'); return; }
    try {
      var val;
      try { val = JSON.parse(raw); } catch (e) { val = raw; }
      currentIns[k] = val;
      dumpProps();
      setOut('✓ ' + k + ' = ' + preview(val));
      log('已修改属性 ' + k);
    } catch (e) {
      setOut('✗ 修改失败: ' + e.message);
    }
  }

  function dumpNodes() {
    try {
      var scene = cc.director.getScene();
      if (!scene) { setOut('场景未就绪'); return; }
      var lines = [];
      var limit = 320;
      function walk(node, depth) {
        if (!node || lines.length >= limit) return;
        var comps = [];
        try {
          (node._components || []).forEach(function (c) {
            var n = (c && c.__classname__) || (c && c.constructor && c.constructor.name) || '?';
            comps.push(n);
          });
        } catch (e) {}
        lines.push(new Array(depth + 1).join('  ') + node.name +
          ' [' + (node.activeInHierarchy ? 'on' : 'off') + ']' +
          (comps.length ? ' <' + comps.join('|') + '>' : ''));
        var ch = node.children || [];
        for (var i = 0; i < ch.length; i++) walk(ch[i], depth + 1);
      }
      walk(scene, 0);
      setOut(lines.join('\n') + (lines.length >= limit ? '\n…(截断)' : ''));
      log('节点树已导出 ' + lines.length + ' 项');
    } catch (e) {
      setOut('✗ ' + e.message);
    }
  }

  function evalJS() {
    var code = (($('yg-eval') || {}).value || '').trim();
    if (!code) return;
    try {
      var ret = (0, eval)(code);
      setOut('✓ 执行完成\n返回: ' + preview(ret));
    } catch (e) {
      setOut('✗ ' + e.message);
    }
  }

  /* ---------- 定时循环调用 ---------- */

  function startTimerTask() {
    if (state.timerTask.timer) stopTimerTask();
    var iv = Math.max(0.5, parseFloat(($('yg-timer-iv') || {}).value) || 5);
    var method = (($('yg-method') || {}).value || '').trim();
    var argsText = (($('yg-args') || {}).value || '').trim() || '[]';
    if (!currentClass) { log('先解析一个类', false); return; }
    if (!method) { log('先选择方法', false); return; }
    var args;
    try {
      args = JSON.parse(argsText);
      if (!Array.isArray(args)) args = [args];
    } catch (e) { log('参数不是合法 JSON 数组', false); return; }
    state.timerTask.iv = iv;
    state.timerTask.method = method;
    state.timerTask.args = argsText;
    state.timerTask.count = 0;
    state.timerTask.timer = setInterval(safe(function () {
      var m = state.timerTask.method;
      var isStatic = m.indexOf('static:') === 0;
      if (isStatic) m = m.slice(7);
      var ctx = isStatic ? currentClass : (currentIns || currentClass);
      var fn = ctx && ctx[m];
      if (typeof fn === 'function') {
        try { fn.apply(ctx, args); state.timerTask.count++; } catch (e) {}
      }
    }, '定时任务'), Math.round(iv * 1000));
    state.timerTask.on = true;
    var b = $('yg-timer-btn');
    if (b) { b.textContent = '停止定时'; b.className = 'yg-btn yg-on'; }
    log('定时任务已启动: 每 ' + iv + 's 调用 ' + method);
    saveCfg();
  }

  function stopTimerTask() {
    if (state.timerTask.timer) clearInterval(state.timerTask.timer);
    state.timerTask.timer = 0;
    state.timerTask.on = false;
    var b = $('yg-timer-btn');
    if (b) { b.textContent = '启动定时'; b.className = 'yg-btn'; }
  }

  /* ---------- 脚本录制 / 回放 ---------- */

  function loadScript() {
    try {
      var raw = localStorage.getItem(SCRIPT_KEY);
      state.rec.events = raw ? JSON.parse(raw) : [];
    } catch (e) { state.rec.events = []; }
    updateScriptInfo();
  }

  function updateScriptInfo() {
    var el = $('yg-rec-info');
    if (!el) return;
    var ev = state.rec.events || [];
    var dur = ev.length ? Math.round(ev[ev.length - 1].t / 1000) : 0;
    el.textContent = '已录制 ' + ev.length + ' 个点击，约 ' + dur + ' 秒' +
      (ev.length ? '（' + ev.slice(0, 3).map(function (e) { return Math.round(e.x) + ',' + Math.round(e.y); }).join(' → ') + '…）' : '');
  }

  function recordTap(ev) {
    if (!state.rec.on || state.rec.playing) return;
    if (ev.target && ev.target.closest && ev.target.closest('#yg-mod')) return;
    var p = ev.touches ? ev.touches[0] : ev;
    if (!p) return;
    var t = Date.now() - state.rec.startAt;
    state.rec.events.push({ x: p.clientX, y: p.clientY, t: t });
    if (state.rec.events.length > 500) state.rec.events.shift();
    updateScriptInfo();
  }

  function startRecord() {
    state.rec.events = [];
    state.rec.startAt = Date.now();
    state.rec.on = true;
    var b = $('yg-rec-btn');
    if (b) { b.textContent = '停止录制'; b.className = 'yg-btn yg-on'; }
    log('开始录制：现在点击游戏画面');
  }

  function stopRecord() {
    state.rec.on = false;
    var b = $('yg-rec-btn');
    if (b) { b.textContent = '开始录制'; b.className = 'yg-btn'; }
    try { localStorage.setItem(SCRIPT_KEY, JSON.stringify(state.rec.events)); } catch (e) {}
    updateScriptInfo();
    log('录制结束，共 ' + state.rec.events.length + ' 个点击');
  }

  function playScript() {
    var ev = state.rec.events || [];
    if (!ev.length) { log('还没有录制的脚本', false); return; }
    if (state.rec.playing) { stopPlay(); return; }
    var loops = parseInt(($('yg-rec-loops') || {}).value, 10) || 0;
    var spd = Math.max(0.2, parseFloat(($('yg-rec-speed') || {}).value) || 1);
    state.rec.playing = true;
    state.rec.loops = loops;
    state.rec.idx = 0;
    state.rec.runId++;
    var runId = state.rec.runId;
    var b = $('yg-rec-play');
    if (b) { b.textContent = '停止回放'; b.className = 'yg-btn yg-on'; }
    log('开始回放 ' + ev.length + ' 个点击，' + (loops ? loops + ' 轮' : '无限循环') + '，速度 ' + spd + 'x');

    function playOnce(done) {
      var i = 0;
      (function next() {
        if (!state.rec.playing || state.rec.runId !== runId) return;
        if (i >= ev.length) return done();
        var prev = i === 0 ? 0 : ev[i - 1].t;
        var gap = Math.max(16, (ev[i].t - prev) / spd);
        setTimeout(function () {
          if (!state.rec.playing || state.rec.runId !== runId) return;
          fireTap(ev[i].x, ev[i].y);
          i++;
          next();
        }, gap);
      })();
    }

    function loop() {
      if (!state.rec.playing || state.rec.runId !== runId) return;
      playOnce(function () {
        if (!state.rec.playing || state.rec.runId !== runId) return;
        if (loops > 0) {
          state.rec.loops--;
          if (state.rec.loops <= 0) { stopPlay(); log('回放结束'); return; }
        }
        setTimeout(loop, 500);
      });
    }
    loop();
  }

  function stopPlay() {
    state.rec.playing = false;
    state.rec.runId++;
    var b = $('yg-rec-play');
    if (b) { b.textContent = '回放脚本'; b.className = 'yg-btn'; }
  }

  /* ---------- 物品图鉴（官方离线配置表） ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function itemName(id) {
    var db = window.YG_ITEM_DB || [];
    for (var i = 0; i < db.length; i++) if (db[i][0] === id) return db[i][1];
    try {
      var br = bridge();
      var IL = br && br.ItemLO;
      if (IL && IL.get) { var lo = IL.get(id); if (lo && lo.name) return lo.name; }
    } catch (e) {}
    return '';
  }

  function renderItems(rows, hint) {
    var box = $('yg-item-list');
    if (!box) return;
    var cnt = $('yg-item-count');
    if (cnt) cnt.textContent = hint || ('共 ' + rows.length + ' 条');
    if (!rows.length) { box.innerHTML = '<div class="yg-tip">没有匹配的物品</div>'; return; }
    var html = [];
    for (var i = 0; i < rows.length && i < 300; i++) {
      var r = rows[i];
      html.push('<div class="yg-item" data-code="' + r[0] + '">' +
        '<div class="yg-item-top"><b>' + esc(r[1]) + '</b><span>' + r[0] + '</span></div>' +
        (r[5] ? '<div class="yg-item-desc">' + esc(r[5]) + '</div>' : '') + '</div>');
    }
    box.innerHTML = html.join('') + (rows.length > 300 ? '<div class="yg-tip">仅显示前 300 条，请加关键字</div>' : '');
  }

  function itemSearch() {
    var db = window.YG_ITEM_DB || [];
    var q = (($('yg-item-q') || {}).value || '').trim().toLowerCase();
    var rows;
    if (!q) rows = db;
    else {
      rows = db.filter(function (r) {
        return String(r[0]).indexOf(q) >= 0 ||
          String(r[1] || '').toLowerCase().indexOf(q) >= 0 ||
          String(r[5] || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    renderItems(rows, '匹配 ' + rows.length + ' 条 / 库 ' + db.length);
  }

  function readBag() {
    if (!window.YG_ITEM_DB) log('物品库未注入', false);
    var br = bridge();
    var BM = (br && br.BagModule) || resolveClass('BagModule');
    var ins = getIns(BM);
    if (!ins) { log('BagModule 不可用（需要登录并进入游戏）', false); return; }
    var list = null;
    try { list = ins.allItems; } catch (e) { log('读取背包失败: ' + e.message, false); return; }
    var n = (list && list.length) || 0;
    if (!n) { log('背包为空，先进游戏再试', false); return; }
    var rows = [];
    for (var i = 0; i < n; i++) {
      var it = typeof list.get === 'function' ? list.get(i) : list[i];
      if (!it) continue;
      var code = it.code != null ? it.code : (it.id != null ? it.id : 0);
      var num = it.num != null ? it.num : (it.count != null ? it.count : '?');
      rows.push([code, itemName(code) || ('未知物品 ' + code), 0, 0, 0, '数量 ' + num]);
    }
    var q = $('yg-item-q');
    if (q) q.value = '';
    renderItems(rows, '背包 ' + rows.length + ' 种');
    log('已读取背包 ' + rows.length + ' 种物品');
  }

  function copyCode(code) {
    var text = String(code);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { log('已复制 ID ' + text); },
        function () { log('复制失败，ID 是 ' + text, false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        log('已复制 ID ' + text);
      } catch (e) { log('复制失败，ID 是 ' + text, false); }
    }
  }

  /* ---------- UI ---------- */

  function tabBtn(id, text) {
    return '<button class="yg-tab" data-tab="' + id + '">' + text + '</button>';
  }

  function build() {
    var wrap = document.createElement('div');
    wrap.id = 'yg-mod';
    wrap.innerHTML =
      '<div id="yg-fab">MOD</div>' +
      '<div id="yg-panel">' +
      '  <div id="yg-head">' +
      '    <span id="yg-title">妖怪金手指 MOD v3</span>' +
      '    <span class="yg-head-btns"><b id="yg-min">—</b><b id="yg-close">×</b></span>' +
      '  </div>' +
      '  <div id="yg-tabs">' +
      tabBtn('main', '常用') + tabBtn('item', '物品') + tabBtn('gm', 'GM') + tabBtn('auto', '自动化') + tabBtn('log', '日志') +
      '  </div>' +
      '  <div id="yg-body">' +

      /* 常用 */
      '  <div class="yg-page" data-page="main">' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">运行状态</div>' +
      '      <div id="yg-stat" class="yg-stat">检测中…</div>' +
      '      <div class="yg-row yg-wrap">' +
      '        <button id="yg-diag" class="yg-btn">重新检测</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">本地速度 <span id="yg-speed-val">1.0x</span></div>' +
      '      <input id="yg-speed" type="range" min="0.1" max="10" step="0.1" value="1">' +
      '      <div class="yg-row yg-wrap">' +
      '        <button class="yg-btn yg-preset" data-v="1">1x</button>' +
      '        <button class="yg-btn yg-preset" data-v="2">2x</button>' +
      '        <button class="yg-btn yg-preset" data-v="3">3x</button>' +
      '        <button class="yg-btn yg-preset" data-v="5">5x</button>' +
      '        <button class="yg-btn yg-preset" data-v="10">10x</button>' +
      '      </div>' +
      '      <div class="yg-tip">直接放大引擎每帧 deltaTime：动画、Tween、走路、计时器会真实变快；服务器冷却/挂机收益/战斗结算由服务端决定，无法加速</div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">快捷</div>' +
      '      <div class="yg-row yg-wrap">' +
      '        <button id="yg-gm-open" class="yg-btn yg-primary">打开内置 GM</button>' +
      '        <button id="yg-guide-btn" class="yg-btn">跳过引导</button>' +
      '        <button id="yg-mute-btn" class="yg-btn">静音</button>' +
      '        <button id="yg-nodes" class="yg-btn">节点树</button>' +
      '      </div>' +
      '      <div class="yg-tip">内置 GM 会按需加载 gm 分包，打开后是官方调试面板</div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">连点器</div>' +
      '      <div class="yg-row"><label>间隔</label>' +
      '        <input id="yg-click-iv" type="number" min="50" step="10" value="120">' +
      '        <span class="yg-tip2">ms</span></div>' +
      '      <div class="yg-row yg-wrap">' +
      '        <button id="yg-pick" class="yg-btn">选位置</button>' +
      '        <button id="yg-click-btn" class="yg-btn">开始连点</button>' +
      '      </div>' +
      '      <div class="yg-tip">位置: <span id="yg-cross-pos">未设置</span></div>' +
      '    </div>' +
      '  </div>' +

      /* 物品 */
      '  <div class="yg-page" data-page="item">' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">物品查询 <span id="yg-item-count" class="yg-tip2"></span></div>' +
      '      <div class="yg-row"><input id="yg-item-q" placeholder="输入名字或 ID，如 芯片 / 30000004"></div>' +
      '      <div class="yg-row yg-wrap">' +
      '        <button id="yg-item-all" class="yg-btn">全部</button>' +
      '        <button id="yg-item-bag" class="yg-btn yg-primary">读当前背包</button>' +
      '      </div>' +
      '      <div class="yg-tip">名称取自官方配置表 config.bin，离线可用；点条目复制物品 ID</div>' +
      '      <div id="yg-item-list"></div>' +
      '    </div>' +
      '  </div>' +

      /* GM */
      '  <div class="yg-page" data-page="gm">' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">说明</div>' +
      '      <div class="yg-tip">本服官方配置 checkConfig 没有 OpenGM，GM 分包默认不加载；GM 指令由服务器校验权限，普通账号发送也会被拒绝，无法凭空加物品/改数值。这里的模块调用与属性修改只影响客户端内存，服务器会以自身数据为准。</div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">桥接模块</div>' +
      '      <div class="yg-row"><select id="yg-bridge"><option value="">— 选择 __GM_BRIDGE__ 模块 —</option></select></div>' +
      '      <div class="yg-tip">游戏主包导出的模块，选一个会自动解析</div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-row"><input id="yg-cls" placeholder="类名，如 BattleMgr"><button id="yg-inspect" class="yg-btn">解析</button></div>' +
      '      <div class="yg-row"><input id="yg-find" placeholder="关键字搜索类名"><button id="yg-search" class="yg-btn">搜索</button></div>' +
      '      <div class="yg-row"><select id="yg-method"></select><button id="yg-call" class="yg-btn">调用</button></div>' +
      '      <div class="yg-row"><input id="yg-args" placeholder="参数 JSON 数组，如 [1,true]"></div>' +
      '      <pre id="yg-out"></pre>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">属性</div>' +
      '      <pre id="yg-props" class="yg-props"></pre>' +
      '      <div class="yg-row"><input id="yg-prop-k" placeholder="属性名"><input id="yg-prop-v" placeholder="新值(JSON或文本)"><button id="yg-prop-set" class="yg-btn">改</button></div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">定时循环</div>' +
      '      <div class="yg-row"><label>每</label><input id="yg-timer-iv" type="number" min="0.5" step="0.5" value="5"><span class="yg-tip2">秒调用当前方法</span></div>' +
      '      <button id="yg-timer-btn" class="yg-btn">启动定时</button>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">执行 JS</div>' +
      '      <textarea id="yg-eval" placeholder="例如 cc.director.getScheduler().setTimeScale(2)"></textarea>' +
      '      <button id="yg-eval-btn" class="yg-btn">执行</button>' +
      '    </div>' +
      '  </div>' +

      /* 自动化 */
      '  <div class="yg-page" data-page="auto">' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">脚本录制 / 回放</div>' +
      '      <div class="yg-row yg-wrap">' +
      '        <button id="yg-rec-btn" class="yg-btn">开始录制</button>' +
      '        <button id="yg-rec-play" class="yg-btn">回放脚本</button>' +
      '      </div>' +
      '      <div id="yg-rec-info" class="yg-tip">未录制</div>' +
      '      <div class="yg-row"><label>轮数</label><input id="yg-rec-loops" type="number" min="0" value="0"><span class="yg-tip2">0=无限</span>' +
      '        <label>速度</label><input id="yg-rec-speed" type="number" min="0.2" step="0.2" value="1"></div>' +
      '      <div class="yg-row"><button id="yg-rec-clear" class="yg-btn yg-danger">清空脚本</button></div>' +
      '      <div class="yg-tip">录制时点游戏画面，回放按原始节奏循环，可做挂机/收菜循环</div>' +
      '    </div>' +
      '    <div class="yg-sec">' +
      '      <div class="yg-h">断线守护</div>' +
      '      <div class="yg-row yg-wrap">' +
      '        <button id="yg-reconnect" class="yg-btn">一键重连检测</button>' +
      '      </div>' +
      '      <div class="yg-tip">检测 socket 状态并尝试重新登录</div>' +
      '    </div>' +
      '  </div>' +

      /* 日志 */
      '  <div class="yg-page" data-page="log">' +
      '    <div class="yg-row yg-wrap">' +
      '      <button id="yg-log-copy" class="yg-btn">复制日志</button>' +
      '      <button id="yg-log-clear" class="yg-btn">清空</button>' +
      '    </div>' +
      '    <div id="yg-log"></div>' +
      '  </div>' +

      '  </div>' +
      '</div>' +
      '<div id="yg-cross"></div>';
    document.body.appendChild(wrap);

    var fab = $('yg-fab');
    var panel = $('yg-panel');

    /* 打开/关闭 */
    function openPanel() {
      state.panelOpen = true;
      panel.style.display = 'flex';
      fab.style.display = 'none';
      saveCfg();
    }
    function closePanel() {
      state.panelOpen = false;
      panel.style.display = 'none';
      fab.style.display = 'flex';
      saveCfg();
    }
    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.panelOpen) closePanel(); else openPanel();
    });
    $('yg-min').addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    $('yg-close').addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });

    /* 阻止事件穿透到游戏 */
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchmove', 'mousedown', 'mouseup', 'click', 'wheel'].forEach(function (ev) {
      panel.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
    });

    /* 标签页 */
    function switchTab(name) {
      state.tab = name;
      var tabs = document.querySelectorAll('#yg-tabs .yg-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].className = 'yg-tab' + (tabs[i].getAttribute('data-tab') === name ? ' yg-tab-on' : '');
      }
      var pages = document.querySelectorAll('#yg-body .yg-page');
      for (var j = 0; j < pages.length; j++) {
        pages[j].style.display = pages[j].getAttribute('data-page') === name ? 'block' : 'none';
      }
      if (name === 'gm') fillBridge();
      if (name === 'item') itemSearch();
      saveCfg();
    }
    var tabEls = document.querySelectorAll('#yg-tabs .yg-tab');
    for (var ti = 0; ti < tabEls.length; ti++) {
      (function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          switchTab(el.getAttribute('data-tab'));
        });
      })(tabEls[ti]);
    }

    /* 拖动：悬浮球 */
    function makeDraggable(el, which) {
      var drag = null;
      function start(e) {
        var p = e.touches ? e.touches[0] : e;
        drag = {
          x: p.clientX, y: p.clientY,
          l: el.offsetLeft, t: el.offsetTop,
          moved: false
        };
      }
      function move(e) {
        if (!drag) return;
        var p = e.touches ? e.touches[0] : e;
        var dx = p.clientX - drag.x;
        var dy = p.clientY - drag.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        var w = el.offsetWidth;
        var h = el.offsetHeight;
        var x = Math.min(window.innerWidth - w - 4, Math.max(4, drag.l + dx));
        var y = Math.min(window.innerHeight - h - 4, Math.max(4, drag.t + dy));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        if (e.cancelable) e.preventDefault();
      }
      function end() {
        if (drag && drag.moved) {
          if (which === 'fab') {
            state.fab.x = el.offsetLeft;
            state.fab.y = el.offsetTop;
          } else {
            state.panelPos.x = el.offsetLeft;
            state.panelPos.y = el.offsetTop;
          }
          saveCfg();
        }
        drag = null;
      }
      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchmove', move, { passive: false });
      el.addEventListener('touchend', end);
      el.addEventListener('mousedown', function (e) {
        start(e);
        var mm = function (ev) { move(ev); };
        var mu = function () {
          end();
          document.removeEventListener('mousemove', mm);
          document.removeEventListener('mouseup', mu);
        };
        document.addEventListener('mousemove', mm);
        document.addEventListener('mouseup', mu);
      });
      el._ygDragProxy = { move: move, end: end };
    }
    makeDraggable(fab, 'fab');
    makeDraggable($('yg-head'), 'panel');

    /* 恢复配置 */
    loadCfg();
    if (state.fab.x >= 0) {
      fab.style.left = state.fab.x + 'px';
      fab.style.top = state.fab.y + 'px';
      fab.style.right = 'auto';
    }
    if (state.panelPos.x >= 0) {
      panel.style.left = state.panelPos.x + 'px';
      panel.style.top = state.panelPos.y + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    if ($('yg-speed')) $('yg-speed').value = state.speed;
    if ($('yg-speed-val')) $('yg-speed-val').textContent = Number(state.speed).toFixed(1) + 'x';
    if ($('yg-click-iv')) $('yg-click-iv').value = state.clicker.interval;
    if ($('yg-timer-iv')) $('yg-timer-iv').value = state.timerTask.iv;
    if (state.skipGuide) {
      var gb = $('yg-guide-btn');
      if (gb) { gb.textContent = '恢复引导'; gb.className = 'yg-btn yg-on'; }
    }
    if (state.muted) {
      var mb = $('yg-mute-btn');
      if (mb) { mb.textContent = '取消静音'; mb.className = 'yg-btn yg-on'; }
    }
    if (state.clicker.set) moveCrosshair(state.clicker.x, state.clicker.y);
    loadScript();
    switchTab(state.tab);

    /* 事件绑定 */
    $('yg-speed').addEventListener('input', safe(function () {
      applySpeed(parseFloat(this.value), true);
    }, '变速'));
    $('yg-speed').addEventListener('change', safe(function () {
      applySpeed(parseFloat(this.value));
    }, '变速'));

    var presets = document.querySelectorAll('.yg-preset');
    for (var pi = 0; pi < presets.length; pi++) {
      (function (el) {
        el.addEventListener('click', safe(function () {
          applySpeed(parseFloat(el.getAttribute('data-v')));
        }, '预设速度'));
      })(presets[pi]);
    }

    $('yg-pick').addEventListener('click', safe(pickPosition, '选取位置'));
    $('yg-click-btn').addEventListener('click', safe(function () {
      if (state.clicker.on) stopClicker(); else startClicker();
    }, '连点'));
    $('yg-guide-btn').addEventListener('click', safe(function () {
      applySkipGuide(!state.skipGuide);
    }, '跳过引导'));
    $('yg-mute-btn').addEventListener('click', safe(function () {
      applyMute(!state.muted);
    }, '静音'));
    $('yg-gm-open').addEventListener('click', safe(openBuiltinGM, 'GM面板'));
    $('yg-nodes').addEventListener('click', safe(function () {
      switchTab('gm');
      dumpNodes();
    }, '节点树'));

    $('yg-diag').addEventListener('click', safe(function () {
      updateStat();
      var br = bridge();
      log('重新检测：桥接 ' + (br ? Object.keys(br).length : 0) + ' 项 · cc ' +
        (window.cc ? '已就绪' : '未就绪') + ' · 物品库 ' + ((window.YG_ITEM_DB || []).length) + ' 条');
    }, '检测'));
    $('yg-item-q').addEventListener('input', safe(itemSearch, '搜索物品'));
    $('yg-item-all').addEventListener('click', safe(function () {
      $('yg-item-q').value = '';
      itemSearch();
    }, '全部物品'));
    $('yg-item-bag').addEventListener('click', safe(readBag, '读背包'));
    $('yg-item-list').addEventListener('click', safe(function (e) {
      var el = e.target;
      while (el && el !== this) {
        if (el.className && String(el.className).indexOf('yg-item') === 0) break;
        el = el.parentNode;
      }
      if (el && el !== this && el.getAttribute) copyCode(el.getAttribute('data-code'));
    }, '复制ID'));

    $('yg-inspect').addEventListener('click', safe(function () {
      selectClass(($('yg-cls').value || '').trim());
    }, '解析'));
    $('yg-search').addEventListener('click', safe(function () {
      var kw = ($('yg-find').value || '').trim();
      var list = classNames(kw);
      setOut(list.length ? list.slice(0, 300).join('\n') + (list.length > 300 ? '\n…共 ' + list.length + ' 个' : '') : '没有匹配（等游戏加载完成再试）');
    }, '搜索'));
    $('yg-call').addEventListener('click', safe(callMethod, '调用'));
    $('yg-prop-set').addEventListener('click', safe(setProp, '改属性'));
    $('yg-timer-btn').addEventListener('click', safe(function () {
      if (state.timerTask.on) stopTimerTask(); else startTimerTask();
    }, '定时任务'));
    $('yg-eval-btn').addEventListener('click', safe(evalJS, '执行JS'));

    $('yg-rec-btn').addEventListener('click', safe(function () {
      if (state.rec.on) stopRecord(); else startRecord();
    }, '录制'));
    $('yg-rec-play').addEventListener('click', safe(playScript, '回放'));
    $('yg-rec-clear').addEventListener('click', safe(function () {
      state.rec.events = [];
      try { localStorage.removeItem(SCRIPT_KEY); } catch (e) {}
      updateScriptInfo();
      log('脚本已清空');
    }, '清空脚本'));
    $('yg-reconnect').addEventListener('click', safe(function () {
      var br = bridge();
      var SM = (br && br.SocketMgr) || resolveClass('SocketMgr');
      var ins = getIns(SM);
      var out = [];
      try {
        if (ins) {
          out.push('SocketMgr: ' + (ins.connected || ins._connected ? '已连接' : '未连接/未知'));
          Object.keys(ins).slice(0, 8).forEach(function (k) {
            var v = ins[k];
            if (v === null || typeof v !== 'object') out.push('  ' + k + ' = ' + preview(v));
          });
        } else out.push('找不到 SocketMgr 单例');
      } catch (e) { out.push('读取失败: ' + e.message); }
      setOut(out.join('\n'));
      log('重连检测完成（详见 GM 页输出）');
      switchTab('gm');
    }, '重连检测'));

    $('yg-log-copy').addEventListener('click', safe(function () {
      var box = $('yg-log');
      var text = box ? box.innerText : '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { log('日志已复制'); }, function () { log('复制失败', false); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); log('日志已复制'); } catch (e) { log('复制失败', false); }
        document.body.removeChild(ta);
      }
    }, '复制日志'));
    $('yg-log-clear').addEventListener('click', safe(function () {
      var box = $('yg-log');
      if (box) box.innerHTML = '';
    }, '清空日志'));

    /* 桥接下拉 */
    function fillBridge() {
      var br = bridge();
      var sel = $('yg-bridge');
      if (!br || !sel) return false;
      var keys = Object.keys(br).sort();
      if (sel.getAttribute('data-filled') === String(keys.length)) return true;
      sel.innerHTML = '<option value="">— 选择 __GM_BRIDGE__ 模块 (' + keys.length + ') —</option>';
      keys.forEach(function (k) {
        var o = document.createElement('option');
        o.value = k;
        o.textContent = k;
        sel.appendChild(o);
      });
      sel.setAttribute('data-filled', String(keys.length));
      return true;
    }
    $('yg-bridge').addEventListener('change', safe(function () {
      var k = this.value;
      if (!k) return;
      $('yg-cls').value = k;
      selectClass(k);
    }, '选择桥接模块'));

    /* 录制监听 */
    document.addEventListener('touchstart', safe(recordTap, '录制'), true);
    document.addEventListener('mousedown', safe(recordTap, '录制'), true);

    /* 全局异常 */
    window.addEventListener('error', function (ev) {
      if (!ev) return;
      log('页面异常: ' + (ev.message || '') + ' @' + (ev.filename || '') + ':' + (ev.lineno || 0), false);
    });

    waitCC(function () {
      installSpeedHook();
      startFpsMeter();
      if (Math.abs(state.speed - 1) > 0.01) applySpeed(state.speed, true);
      var has = fillBridge();
      updateStat();
      if (window.YG_ITEM_DB) renderItems(window.YG_ITEM_DB.slice(0, 300), '共 ' + window.YG_ITEM_DB.length + ' 条（显示前 300）');
      log('cc 已就绪，MOD v3 可用' + (has ? '（桥接 ' + Object.keys(bridge() || {}).length + ' 项）' : ''));
    });

    if (state.panelOpen) openPanel(); else closePanel();

    window.YG_MOD = {
      resolve: resolveClass,
      ins: getIns,
      bridge: bridge,
      setSpeed: applySpeed,
      skipGuide: applySkipGuide,
      openGM: openBuiltinGM,
      items: itemSearch,
      itemName: itemName,
      bag: readBag,
      stat: updateStat,
      nodes: dumpNodes,
      call: function (cls, method, args) {
        selectClass(cls, true);
        $('yg-method').value = method;
        $('yg-args').value = JSON.stringify(args || []);
        callMethod();
      },
      log: log
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
