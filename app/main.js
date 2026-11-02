/* CCTV Multi-Brand Viewer for Samsung Tizen TV & Web Preview.
   Supports go2rtc Gateway (WebRTC/MSE/HLS/MJPEG) + Direct AVPlay Fallback.
   10-Foot Navigation, Auto-Refresh Snapshot Grid & Fullscreen Live Player.
   ES5 compatible. */
(function () {
  'use strict';

  var STORAGE_KEYS = {
    CAMERAS: 'cctvframe.cameras.v3',
    GATEWAY: 'cctvframe.gateway.v3',
    LAYOUT: 'cctvframe.layout.v3'
  };

  /* Brand RTSP Templates */
  var BRAND_PRESETS = {
    tapo: function (c) {
      var path = (c.subtype === 'main') ? '/stream1' : '/stream2';
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + path;
    },
    imou: function (c) {
      var ch = parseInt(c.channel || 1, 10);
      var subtype = (c.subtype === 'main') ? 0 : 1;
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + '/cam/realmonitor?channel=' + ch + '&subtype=' + subtype;
    },
    hikvision: function (c) {
      var ch = parseInt(c.channel || 1, 10);
      var streamId = (ch * 100) + (c.subtype === 'main' ? 1 : 2); // e.g. Channel 1: 101 main, 102 sub
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + '/Streaming/Channels/' + streamId;
    },
    dahua: function (c) {
      var subtype = (c.subtype === 'main') ? 0 : 1;
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + '/cam/realmonitor?channel=' + (c.channel || 1) + '&subtype=' + subtype;
    },
    reolink: function (c) {
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + (c.subtype === 'main' ? '/h264Preview_01_main' : '/h264Preview_01_sub');
    },
    custom: function (c) {
      return c.customUrl || '';
    }
  };

  var DEMO_CAMERAS = [
    { id: 'demo1', name: 'Front Porch (TP-Link Tapo)', brand: 'tapo', ip: '192.168.1.101', port: 554, channel: 1, user: 'camera_account', pass: 'CameraPass123', streamName: 'demo_tapo', isDemo: true },
    { id: 'demo2', name: 'Driveway (Imou Bullet)', brand: 'imou', ip: '192.168.1.102', port: 554, channel: 1, user: 'admin', pass: 'SAFETYCODE', streamName: 'demo_imou', isDemo: true }
  ];

  var state = {
    gatewayUrl: '',
    cameras: [],
    gridMode: 4, // 1, 2, 4, or 6
    focusedIndex: 0,
    isFullscreen: false,
    hudVisible: true,
    hudTimer: null,
    snapshotTimer: null,
    toastTimer: null,
    clockTimer: null,
    discoveryTimer: null,
    snapFails: 0,
    isModalOpen: false,
    hasAvplay: typeof window.webapis !== 'undefined' && typeof window.webapis.avplay !== 'undefined'
  };

  /* Samsung TV Key Codes */
  var KEYS = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    ENTER: 13,
    BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    KEY_1: 49, KEY_2: 50, KEY_3: 51, KEY_4: 52, KEY_5: 53, KEY_6: 54,
    MENU: 10182
  };

  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* Hide the user:password part of an RTSP URL before showing it on screen. */
  function maskUrl(url) {
    return String(url || '').replace(/(:\/\/)[^\/@\s]*@/, '$1***:***@');
  }

  /* The backend API lives on the page origin in a browser; inside a TV widget it is the gateway host on port 4800. */
  function backendBase() {
    if (/^https?:$/.test(window.location.protocol)) return '';
    var m = /^(https?:\/\/[^\/:]+)/.exec(state.gatewayUrl || '');
    return m ? m[1] + ':4800' : null;
  }

  /* JSON request to the backend. cb(err, data) is always called exactly once. */
  function api(method, path, body, cb) {
    var base = backendBase();
    if (base === null) { cb(new Error('Set the gateway address in Settings first.')); return; }
    var done = false;
    function finish(err, data) { if (!done) { done = true; cb(err, data); } }
    var xhr = new XMLHttpRequest();
    xhr.open(method, base + path, true);
    xhr.timeout = 15000;
    if (body !== null && body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status >= 200 && xhr.status < 300) finish(null, data || {});
      else finish(new Error((data && data.message) || ('Backend error ' + xhr.status)), data);
    };
    xhr.onerror = function () { finish(new Error('Cannot reach the CCTVFrame backend.')); };
    xhr.ontimeout = function () { finish(new Error('Backend request timed out.')); };
    try { xhr.send(body !== null && body !== undefined ? JSON.stringify(body) : null); } catch (e) { finish(e); }
  }

  /* ---------- Toast Notification Banner ---------- */

  function showToast(msg) {
    var banner = $('toastBanner');
    if (!banner) return;
    banner.textContent = msg;
    banner.style.display = 'flex';
    banner.classList.remove('is-hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      banner.classList.add('is-hidden');
      setTimeout(function () { banner.style.display = 'none'; }, 350);
    }, 3200);
  }

  /* ---------- Storage & Settings ---------- */

  function isOnlyDemoCameras() {
    if (!state.cameras || state.cameras.length === 0) return false;
    for (var i = 0; i < state.cameras.length; i++) {
      if (!state.cameras[i].isDemo) return false;
    }
    return true;
  }

  function getAutoGatewayUrl() {
    if (!/^https?:$/.test(window.location.protocol)) return '';
    var host = window.location.hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1') {
      return 'http://127.0.0.1:1984';
    }
    return 'http://' + host + ':1984';
  }

  function loadState() {
    try {
      var savedG = localStorage.getItem(STORAGE_KEYS.GATEWAY);
      state.gatewayUrl = savedG || getAutoGatewayUrl();

      var savedC = localStorage.getItem(STORAGE_KEYS.CAMERAS);
      if (savedC) {
        state.cameras = JSON.parse(savedC);
      } else {
        state.cameras = DEMO_CAMERAS.slice();
      }

      var savedL = localStorage.getItem(STORAGE_KEYS.LAYOUT);
      if (savedL) {
        state.gridMode = parseInt(savedL, 10) || 4;
      } else {
        state.gridMode = state.cameras.length === 2 ? 2 : 4;
      }
    } catch (e) {
      state.cameras = DEMO_CAMERAS.slice();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEYS.GATEWAY, state.gatewayUrl);
      localStorage.setItem(STORAGE_KEYS.CAMERAS, JSON.stringify(state.cameras));
      localStorage.setItem(STORAGE_KEYS.LAYOUT, String(state.gridMode));
    } catch (e) { }
    syncToBackend();
  }

  function syncToBackend() {
    // Demo cameras are placeholders and must never be registered with the gateway
    var real = (state.cameras || []).filter(function (c) { return !c.isDemo; });
    var payload = real.map(function (c) {
      return {
        id: c.id,
        name: c.name,
        brand: c.brand,
        ip: c.ip,
        port: c.port,
        channel: c.channel,
        streamName: c.streamName,
        url: getStreamUrl(c, 'sub')
      };
    });
    api('POST', '/api/sync_streams', payload, function () { });
  }

  /* ---------- Stream and Snapshot URLs ---------- */

  function getSnapshotUrl(cam) {
    if (!cam) return '';
    if (state.gatewayUrl && cam.streamName) {
      var base = state.gatewayUrl.replace(/\/+$/, '');
      return base + '/api/frame.jpeg?src=' + encodeURIComponent(cam.streamName) + '&t=' + Date.now();
    }
    return '';
  }

  function getStreamUrl(cam, quality) {
    if (!cam) return '';
    // 1. Direct RTSP URL computation (quality: 'sub' | 'main'; default is the camera's own setting, else sub)
    if (cam.brand && BRAND_PRESETS[cam.brand]) {
      var clone = {
        ip: cam.ip,
        port: cam.port || 554,
        user: cam.user || '',
        pass: cam.pass || '',
        channel: cam.channel || 1,
        customUrl: cam.customUrl || cam.url || '',
        subtype: quality === 'main' ? 'main' : (quality === 'sub' ? 'sub' : (cam.subtype || 'sub'))
      };
      return BRAND_PRESETS[cam.brand](clone);
    }
    return cam.url || '';
  }

  function getGatewayPlayUrl(cam) {
    if (!cam) return '';
    if (state.gatewayUrl && cam.streamName) {
      var base = state.gatewayUrl.replace(/\/+$/, '');
      return base + '/api/stream.mp4?src=' + encodeURIComponent(cam.streamName);
    }
    return getStreamUrl(cam);
  }

  function checkGateway() {
    var badge = $('gatewayBadge');
    if (!state.gatewayUrl) {
      if (badge) { badge.textContent = 'Direct AVPlay Mode'; badge.className = 'gateway-badge'; }
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', state.gatewayUrl.replace(/\/+$/, '') + '/api/streams', true);
    xhr.timeout = 2500;
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (badge) { badge.textContent = 'go2rtc Gateway Active'; badge.className = 'gateway-badge is-connected'; }
        } else {
          if (badge) { badge.textContent = 'Gateway Standby / Offline'; badge.className = 'gateway-badge'; }
        }
      }
    };
    xhr.onerror = function () {
      if (badge) { badge.textContent = 'Gateway Standby / Offline'; badge.className = 'gateway-badge'; }
    };
    try { xhr.send(); } catch (e) { }
  }

  /* ---------- Live Grid Wall Rendering ---------- */

  function renderGrid() {
    var wall = $('gridWall');
    if (!wall) return;

    // Adapt layout if exactly 2 cameras
    var effectiveGrid = state.gridMode;

    wall.className = 'grid-wall grid-' + effectiveGrid;
    wall.innerHTML = '';

    var count = Math.min(effectiveGrid, state.cameras.length);
    // Focusable slots = cameras plus the "add camera" tile when there is room
    var slots = count + (count < effectiveGrid ? 1 : 0);
    if (state.focusedIndex >= slots) state.focusedIndex = Math.max(0, slots - 1);

    if (count === 0) {
      wall.innerHTML = [
        '<div class="empty-stage-card">',
        '<span style="font-size:64px;">📹</span>',
        '<h2 style="color:#f8fafc; font-size:32px; font-weight:700;">No Cameras Configured</h2>',
        '<p style="font-size:18px; color:#94a3b8; max-width:540px; text-align:center;">Connect your TP-Link Tapo, Imou Bullet, or standard RTSP/NVR camera feeds to start live viewing.</p>',
        '<button class="btn btn-primary" id="btnEmptyAdd" style="padding:14px 32px; font-size:18px; font-weight:700; border-radius:12px; margin-top:8px;">➕ Add Your First Camera</button>',
        '</div>'
      ].join('');
      var emptyBtn = $('btnEmptyAdd');
      if (emptyBtn) emptyBtn.onclick = openModal;
      return;
    }

    for (var i = 0; i < count; i++) {
      var cam = state.cameras[i];
      var tile = document.createElement('article');
      tile.className = 'cam-tile' + (i === state.focusedIndex ? ' is-focused' : '');
      tile.id = 'tile-' + i;
      tile.setAttribute('data-index', String(i));

      tile.innerHTML = [
        '<div class="tile-media">',
        '<img class="tile-snapshot" id="snap-' + i + '" style="opacity:0" alt="">',
        '<div class="tile-placeholder" id="ph-' + i + '"><span class="ph-icon">📹</span><span>' + esc(cam.brand ? cam.brand.toUpperCase() : 'RTSP') + ' Stream Ready</span></div>',
        '<div class="tile-overlay">',
        '<span class="tile-name">' + esc(cam.name) + '</span>',
        '<span class="status-chip status-connecting" id="chip-' + i + '">CONNECTING</span>',
        '</div>',
        '</div>'
      ].join('');

      (function (index) {
        tile.onclick = function () {
          setFocus(index);
          openFullscreen(index);
        };
      })(i);

      wall.appendChild(tile);
    }

    // If grid has an empty slot available, render an interactive "➕ Add Camera" card right in the grid
    if (count < effectiveGrid) {
      var addTile = document.createElement('article');
      addTile.className = 'cam-tile cam-tile-add' + (count === state.focusedIndex ? ' is-focused' : '');
      addTile.id = 'tile-' + count;
      addTile.title = 'Click to Add Camera';
      addTile.innerHTML = [
        '<div class="tile-add-content">',
        '<span class="tile-add-icon">➕</span>',
        '<span class="tile-add-title">Add Camera ' + (count + 1) + '</span>',
        '<span class="tile-add-subtitle">Connect Tapo, Imou, or RTSP</span>',
        '</div>'
      ].join('');
      addTile.onclick = function () {
        openModal();
      };
      wall.appendChild(addTile);
    }

    refreshSnapshots();
  }

  function refreshSnapshots() {
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = null;
    if (state.isFullscreen || state.isModalOpen) return;
    if (document.hidden) return; // resumed by the visibilitychange handler

    var count = Math.min(state.gridMode, state.cameras.length);
    var anyOk = false, pending = 0;
    for (var i = 0; i < count; i++) {
      (function (index) {
        var cam = state.cameras[index];
        var img = $('snap-' + index);
        if (!img || !cam || img.getAttribute('data-busy') === '1') return;
        var url = getSnapshotUrl(cam);
        if (!url) return;
        pending++;
        img.setAttribute('data-busy', '1');
        img.onload = function () {
          img.setAttribute('data-busy', '0');
          img.style.opacity = '1';
          var chip = $('chip-' + index);
          if (chip) { chip.className = 'status-chip status-live'; chip.textContent = 'LIVE'; }
          state.snapFails = 0;
        };
        img.onerror = function () {
          img.setAttribute('data-busy', '0');
          var chip = $('chip-' + index);
          if (chip) { chip.className = 'status-chip status-offline'; chip.textContent = 'OFFLINE'; }
          state.snapFails = (state.snapFails || 0) + 1;
        };
        img.src = url;
      })(i);
    }

    // Back off while cameras are unreachable to avoid hammering the network
    var delay = (state.snapFails || 0) >= 3 ? 10000 : 3000;
    state.snapshotTimer = setTimeout(refreshSnapshots, delay);
  }

  function focusSlots() {
    var count = Math.min(state.gridMode, state.cameras.length);
    return count + (count < state.gridMode ? 1 : 0);
  }

  function setFocus(newIndex) {
    if (newIndex < 0 || newIndex >= focusSlots()) return;

    var prev = $('tile-' + state.focusedIndex);
    if (prev) prev.classList.remove('is-focused');

    state.focusedIndex = newIndex;

    var curr = $('tile-' + state.focusedIndex);
    if (curr) curr.classList.add('is-focused');
  }

  /* ---------- Fullscreen Live Player ---------- */

  function openFullscreen(camIndex) {
    var cam = state.cameras[camIndex];
    if (!cam) return;

    state.isFullscreen = true;
    state.focusedIndex = camIndex;
    clearTimeout(state.snapshotTimer);
    updateClock();

    var fsView = $('fullscreenView');
    if (fsView) {
      fsView.hidden = false;
      fsView.style.display = 'flex';
      fsView.classList.remove('is-hidden');
    }

    $('fsHudName').textContent = cam.name;
    showHud();

    var directRtsp = getStreamUrl(cam, 'main');
    var gatewayUrl = getGatewayPlayUrl(cam);
    var video = $('fsVideoPlayer');
    $('fsHudStatus').textContent = 'LIVE';
    $('fsHudStatus').className = 'hud-status';

    if (directRtsp.indexOf('rtsp://') === 0 && state.hasAvplay) {
      video.style.display = 'none';
      playAvplay(directRtsp);
      $('fsHudCodec').textContent = 'AVPlay Native RTSP';
    } else {
      if (state.hasAvplay) stopAvplay();
      video.style.display = 'block';
      video.onerror = function () {
        $('fsHudStatus').textContent = 'STREAM ERR';
        $('fsHudStatus').className = 'hud-status status-offline';
      };
      if (!gatewayUrl) {
        video.onerror();
        return;
      }
      video.src = gatewayUrl;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      $('fsHudCodec').textContent = 'go2rtc Low-Latency Stream';
    }
  }

  function closeFullscreen() {
    state.isFullscreen = false;
    var fsView = $('fullscreenView');
    if (fsView) {
      fsView.hidden = true;
      fsView.style.display = 'none';
      fsView.classList.add('is-hidden');
    }

    var video = $('fsVideoPlayer');
    if (video) {
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load(); // drops the HTTP stream connection
    }

    if (state.hasAvplay) stopAvplay();

    showHud(false);
    updateClock();
    refreshSnapshots();
  }

  function showHud(autoHide) {
    var hud = $('fsHud');
    if (!hud) return;

    clearTimeout(state.hudTimer);
    hud.classList.remove('is-hidden');

    if (autoHide !== false) {
      state.hudTimer = setTimeout(function () {
        hud.classList.add('is-hidden');
      }, 5000);
    }
  }

  /* ---------- Samsung AVPlay RTSP Engine ---------- */

  function playAvplay(rtspUrl) {
    try {
      var avplay = window.webapis.avplay;
      avplay.stop();
      avplay.close();
      avplay.open(rtspUrl);
      avplay.setDisplayRect(0, 0, 1920, 1080);
      avplay.setListener({
        onbufferingcomplete: function () {
          $('fsHudStatus').textContent = 'LIVE';
          $('fsHudStatus').className = 'hud-status';
        },
        onerror: function () {
          $('fsHudStatus').textContent = 'STREAM ERR';
          $('fsHudStatus').className = 'hud-status status-offline';
        }
      });
      avplay.prepareAsync(function () {
        avplay.play();
      });
    } catch (e) { }
  }

  function stopAvplay() {
    try {
      window.webapis.avplay.stop();
      window.webapis.avplay.close();
    } catch (e) { }
  }

  /* ---------- Remote Control Key Handler ---------- */

  function modalFocusables() {
    var modal = $('settingsModal');
    var nodes = modal ? modal.querySelectorAll('button, input, select') : [];
    return Array.prototype.filter.call(nodes, function (el) {
      return !el.disabled && !el.readOnly && el.offsetParent !== null;
    });
  }

  function moveModalFocus(step) {
    var items = modalFocusables();
    if (!items.length) return;
    var idx = items.indexOf(document.activeElement);
    var next = idx < 0 ? 0 : Math.max(0, Math.min(items.length - 1, idx + step));
    items[next].focus();
    if (items[next].scrollIntoView) items[next].scrollIntoView(false);
  }

  var IME_DONE = 65376;

  function handleKey(code, ev) {
    if (state.isModalOpen) {
      var active = document.activeElement;
      var isInput = active && active.tagName === 'INPUT';
      var isSelect = active && active.tagName === 'SELECT';
      if (code === KEYS.BACK || code === KEYS.ESC) closeModal();
      else if (code === KEYS.DOWN) { if (ev) ev.preventDefault(); moveModalFocus(1); }
      else if (code === KEYS.UP) { if (ev) ev.preventDefault(); moveModalFocus(-1); }
      else if ((code === KEYS.LEFT || code === KEYS.RIGHT) && isSelect) {
        // Change the option directly so the remote never needs the native popup
        if (ev) ev.preventDefault();
        var n = active.selectedIndex + (code === KEYS.RIGHT ? 1 : -1);
        if (n >= 0 && n < active.options.length) {
          active.selectedIndex = n;
          active.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if ((code === KEYS.LEFT || code === KEYS.RIGHT) && !isInput) {
        if (ev) ev.preventDefault();
        moveModalFocus(code === KEYS.RIGHT ? 1 : -1);
      } else if (code === IME_DONE) {
        // On-screen keyboard "Done": continue to the next field
        if (ev) ev.preventDefault();
        moveModalFocus(1);
      }
      else if (code === KEYS.ENTER && isInput) {
        // Re-trigger focus/click so the TV opens its on-screen keyboard on a single Enter
        active.blur();
        active.focus();
        active.click();
      }
      return;
    }

    // Keyboard shortcuts for PC preview: A / S / B / +
    if (!state.isFullscreen && (code === 65 || code === 83 || code === 66 || code === 187 || code === 107)) {
      openModal();
      return;
    }

    if (state.isFullscreen) {
      var total = state.cameras.length;
      if (code === KEYS.BACK || code === KEYS.ESC) {
        closeFullscreen();
      } else if (code === KEYS.LEFT && total > 0) {
        openFullscreen((state.focusedIndex - 1 + total) % total);
      } else if (code === KEYS.RIGHT && total > 0) {
        openFullscreen((state.focusedIndex + 1) % total);
      } else if (code === KEYS.ENTER) {
        showHud();
      }
      return;
    }

    var cols = state.gridMode === 6 ? 3 : (state.gridMode === 4 || state.gridMode === 2 ? 2 : 1);
    var slots = focusSlots();

    if (code === KEYS.LEFT) {
      if (state.focusedIndex % cols > 0) setFocus(state.focusedIndex - 1);
    } else if (code === KEYS.RIGHT) {
      if (state.focusedIndex % cols < cols - 1 && state.focusedIndex + 1 < slots) setFocus(state.focusedIndex + 1);
    } else if (code === KEYS.UP) {
      if (state.focusedIndex >= cols) setFocus(state.focusedIndex - cols);
    } else if (code === KEYS.DOWN) {
      if (state.focusedIndex + cols < slots) setFocus(state.focusedIndex + cols);
    } else if (code === KEYS.ENTER) {
      if (state.focusedIndex < state.cameras.length && state.focusedIndex < state.gridMode) openFullscreen(state.focusedIndex);
      else openModal();
    } else if (code === KEYS.RED) {
      // Toggle Grid layout: 1 -> 2 -> 4 -> 6 -> 1
      if (state.gridMode === 1) state.gridMode = 2;
      else if (state.gridMode === 2) state.gridMode = 4;
      else if (state.gridMode === 4) state.gridMode = 6;
      else state.gridMode = 1;
      $('modeBadge').textContent = state.gridMode + '-Grid Live Wall';
      saveState();
      renderGrid();
    } else if (code === KEYS.YELLOW) {
      refreshSnapshots();
      showToast('Refreshing camera snapshots...');
    } else if (code === KEYS.BLUE || code === KEYS.MENU) {
      openModal();
    } else if (code >= KEYS.KEY_1 && code <= KEYS.KEY_6) {
      var directIdx = code - KEYS.KEY_1;
      if (directIdx < state.cameras.length) {
        openFullscreen(directIdx);
      }
    } else if (code === KEYS.BACK || code === KEYS.ESC) {
      try {
        if (window.tizen && window.tizen.application) {
          window.tizen.application.getCurrentApplication().exit();
        }
      } catch (e) { }
    }
  }

  /* ---------- Modal & Wizard Logic ---------- */

  function updateWizardUrl() {
    var brand = $('wzBrand').value;
    var fn = BRAND_PRESETS[brand];
    if (fn) {
      var gen = fn({
        ip: $('wzIp').value || '192.168.1.100',
        port: parseInt($('wzPort').value || 554, 10),
        user: $('wzUser').value || '',
        pass: $('wzPass').value || '',
        channel: parseInt($('wzChannel').value || 1, 10)
      });
      $('wzGeneratedUrl').value = maskUrl(gen);
    }
  }

  function addCameraFromWizard() {
    var brand = $('wzBrand').value;
    var ip = ($('wzIp').value || '').trim();
    if (!/^[A-Za-z0-9.\-]+$/.test(ip)) return false; // blocks characters that would alter the RTSP URL

    // If currently only demo cameras exist, clear them so the user's real camera is first
    if (isOnlyDemoCameras()) {
      state.cameras = [];
    }

    var customName = ($('wzName') && $('wzName').value || '').trim();
    var brandLabel = $('wzBrand').options[$('wzBrand').selectedIndex].text.split(' ')[0];
    var name = customName || (brandLabel + ' Camera ' + (state.cameras.length + 1));

    // Same IP on the same NVR channel is the same camera
    var channelNum = parseInt($('wzChannel').value || 1, 10) || 1;
    var existingIdx = -1;
    for (var i = 0; i < state.cameras.length; i++) {
      if (state.cameras[i].ip === ip && (state.cameras[i].channel || 1) === channelNum) {
        existingIdx = i;
        break;
      }
    }

    var sId = existingIdx >= 0 ? state.cameras[existingIdx].id : ('cam_' + Date.now());
    var sName = existingIdx >= 0 ? state.cameras[existingIdx].streamName : ('cam_' + brand + '_' + Date.now());

    var camData = {
      id: sId,
      name: name,
      brand: brand,
      ip: ip,
      port: parseInt($('wzPort').value || 554, 10),
      channel: parseInt($('wzChannel').value || 1, 10),
      user: ($('wzUser').value || '').trim(),
      pass: $('wzPass').value || '',
      streamName: sName,
      isDemo: false
    };

    if (existingIdx >= 0) {
      state.cameras[existingIdx] = camData;
    } else {
      state.cameras.push(camData);
    }

    // Auto switch layout to 2 if 2 cameras
    if (state.cameras.length === 2 && state.gridMode !== 1) {
      state.gridMode = 2;
      var modeB = $('modeBadge');
      if (modeB) modeB.textContent = '2-Grid Live Wall';
    }

    saveState();
    renderConfiguredList();
    renderGrid();
    return true;
  }

  function renderConfiguredList() {
    var list = $('configuredCamList');
    if (!list) return;
    list.innerHTML = '';

    if (state.cameras.length === 0) {
      list.innerHTML = '<div style="color:#94a3b8; font-size:14px; padding:8px 0;">No cameras configured yet. Add your first camera above.</div>';
      return;
    }

    state.cameras.forEach(function (c, idx) {
      var item = document.createElement('div');
      item.className = 'cam-config-item';
      var badge = c.isDemo ? ' <span style="background:#57606f; color:#fff; font-size:11px; padding:2px 6px; border-radius:4px;">DEMO</span>' : '';
      item.innerHTML = [
        '<div style="overflow:hidden;">',
        '<div class="cam-config-name">' + (idx + 1) + '. ' + esc(c.name) + badge + '</div>',
        '<div class="cam-config-url">' + esc(maskUrl(getStreamUrl(c))) + '</div>',
        '</div>',
        '<button class="btn btn-secondary" style="margin-left:auto; font-size:13px;" data-del="' + idx + '">Remove</button>'
      ].join('');
      list.appendChild(item);
    });

    Array.prototype.forEach.call(list.querySelectorAll('[data-del]'), function (btn) {
      btn.onclick = function () {
        var idx = parseInt(btn.getAttribute('data-del'), 10);
        state.cameras.splice(idx, 1);
        saveState();
        renderConfiguredList();
        renderGrid();
        showToast('Camera removed from watchlist.');
      };
    });
  }

  function openModal() {
    state.isModalOpen = true;
    var modal = $('settingsModal');
    if (modal) {
      modal.hidden = false;
      modal.style.display = 'flex';
      modal.classList.remove('is-hidden');
    }
    $('cfgGatewayUrl').value = state.gatewayUrl;
    clearTimeout(state.snapshotTimer);
    renderConfiguredList();
    updateWizardUrl();
    var first = modalFocusables()[0];
    if (first) first.focus();
  }

  function closeModal() {
    state.isModalOpen = false;
    clearTimeout(state.discoveryTimer);
    var modal = $('settingsModal');
    if (modal) {
      modal.hidden = true;
      modal.style.display = 'none';
      modal.classList.add('is-hidden');
    }
    var stageEl = $('stage');
    if (stageEl) stageEl.focus();
    renderGrid();
    checkGateway();
  }

  /* ---------- Clock & Registration ---------- */

  function updateClock() {
    clearTimeout(state.clockTimer);
    if (document.hidden) return; // restarted by the visibilitychange handler

    var now = new Date();
    var h = String(now.getHours());
    var m = String(now.getMinutes());
    var s = String(now.getSeconds());
    if (h.length < 2) h = '0' + h;
    if (m.length < 2) m = '0' + m;
    if (s.length < 2) s = '0' + s;

    var timeStr = h + ':' + m;
    var clockEl = $('clock');
    if (clockEl) clockEl.textContent = timeStr;

    var fsClock = $('fsHudClock');
    if (fsClock) fsClock.textContent = timeStr + ':' + s;

    // Seconds are only shown in the fullscreen HUD; otherwise wake once a minute
    var delay = state.isFullscreen ? 1000 : (60000 - (now.getTime() % 60000) + 50);
    state.clockTimer = setTimeout(updateClock, delay);
  }

  function registerKeys() {
    try {
      if (window.tizen && window.tizen.tvinputdevice) {
        var remoteKeys = ['0', '1', '2', '3', '4', '5', '6', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'MediaPlay', 'MediaStop'];
        remoteKeys.forEach(function (k) {
          try { window.tizen.tvinputdevice.registerKey(k); } catch (e) { }
        });
      }
    } catch (e) { }
  }

  /* ---------- Init ---------- */

  function init() {
    loadState();
    registerKeys();
    updateClock();
    var modeBadge = $('modeBadge');
    if (modeBadge) modeBadge.textContent = state.gridMode + '-Grid Live Wall';
    renderGrid();
    checkGateway();
    syncToBackend(); // go2rtc forgets streams on restart, so re-register them

    // Keydown Listener
    document.addEventListener('keydown', function (e) {
      handleKey(e.keyCode, e);
    });

    // Stop timers while the app is in the background
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(state.snapshotTimer);
        clearTimeout(state.clockTimer);
      } else {
        updateClock();
        refreshSnapshots();
      }
    });

    // Wizard Input Handlers
    ['wzBrand', 'wzIp', 'wzPort', 'wzUser', 'wzPass', 'wzChannel', 'wzName'].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.addEventListener('input', updateWizardUrl);
        el.addEventListener('change', updateWizardUrl);
      }
    });

    // Auto-update placeholders based on brand
    var brandSelect = $('wzBrand');
    if (brandSelect) {
      brandSelect.addEventListener('change', function () {
        var b = brandSelect.value;
        if (b === 'tapo') {
          $('wzUser').placeholder = 'Tapo Camera Account (in app)';
          $('wzPass').placeholder = 'Camera Account Password';
          if (!$('wzName').value) $('wzName').placeholder = 'Front Tapo Camera';
        } else if (b === 'imou') {
          $('wzUser').value = 'admin';
          $('wzPass').placeholder = 'Safety Code (on sticker)';
          if (!$('wzName').value) $('wzName').placeholder = 'Driveway Imou Bullet';
        } else {
          $('wzUser').placeholder = 'admin';
          $('wzPass').placeholder = 'Password';
        }
        updateWizardUrl();
      });
    }

    /* Backend discovery & handshake probe handlers */
    function setStatus(cls, text) {
      var statusEl = $('probeStatus');
      if (statusEl) statusEl.innerHTML = '<span class="' + cls + '">' + esc(text) + '</span>';
    }

    function renderDiscovered(devices) {
      var listEl = $('discoveredList');
      if (!listEl) return;
      if (!devices || !devices.length) { listEl.style.display = 'none'; listEl.innerHTML = ''; return; }
      listEl.style.display = 'flex';
      listEl.innerHTML = '<div style="font-weight:700; margin-top:8px;">Discovered Devices (Click to autofill):</div>';
      devices.forEach(function (dev) {
        var item = document.createElement('div');
        item.className = 'cam-config-item';
        item.style.cursor = 'pointer';
        item.innerHTML = [
          '<div style="overflow:hidden;">',
          '<div class="cam-config-name">📷 ' + esc(dev.brand) + ' (' + esc(dev.ip) + ')</div>',
          '<div class="cam-config-url">RTSP 554: ' + (dev.ports && dev.ports.rtsp ? 'OPEN' : 'CLOSED') + ' | ' + esc(dev.banner) + '</div>',
          '</div>',
          '<button class="btn btn-primary" style="margin-left:auto; padding:6px 12px; font-size:13px;">Use Device</button>'
        ].join('');

        item.onclick = function () {
          $('wzIp').value = dev.ip;
          var b = (dev.brand || '').toLowerCase();
          if (b.indexOf('imou') >= 0) {
            $('wzBrand').value = 'imou';
            $('wzUser').value = 'admin';
            $('wzPass').placeholder = 'Safety Code (on sticker)';
            $('wzName').value = 'Imou Bullet (' + dev.ip + ')';
          } else if (b.indexOf('tapo') >= 0 || b.indexOf('tp-link') >= 0) {
            $('wzBrand').value = 'tapo';
            $('wzUser').placeholder = 'Tapo Camera Account';
            $('wzName').value = 'Tapo Camera (' + dev.ip + ')';
          } else if (b.indexOf('hikvision') >= 0) {
            $('wzBrand').value = 'hikvision';
          } else if (b.indexOf('dahua') >= 0) {
            $('wzBrand').value = 'dahua';
          } else if (b.indexOf('reolink') >= 0) {
            $('wzBrand').value = 'reolink';
          }
          updateWizardUrl();
          showToast('Autofilled settings for ' + dev.brand + ' (' + dev.ip + ')');
        };

        listEl.appendChild(item);
      });
    }

    function pollDiscovery() {
      clearTimeout(state.discoveryTimer);
      if (!state.isModalOpen) return;
      api('GET', '/api/discovery', null, function (err, data) {
        if (err) { setStatus('status-badge-error', '✖ ' + err.message); return; }
        if (data.scanning) {
          setStatus('status-badge-loading', '⏳ ' + (data.progress || 'Scanning local subnet...'));
          state.discoveryTimer = setTimeout(pollDiscovery, 1500);
        } else {
          setStatus('status-badge-success', '✔ ' + (data.progress || 'Scan complete.'));
          renderDiscovered(data.discovered);
        }
      });
    }

    $('btnRunDiscovery').onclick = function () {
      setStatus('status-badge-loading', '🚀 Initiating subnet camera discovery...');
      api('POST', '/api/scan', {}, function (err) {
        if (err) { setStatus('status-badge-error', '✖ ' + err.message); return; }
        pollDiscovery();
      });
    };

    $('btnTestProbe').onclick = function () {
      var ip = ($('wzIp').value || '').trim() || '192.168.1.100';
      var port = parseInt($('wzPort').value || 554, 10) || 554;
      setStatus('status-badge-loading', '⏳ Connecting to ' + ip + ':' + port + ' via RTSP handshake...');
      api('POST', '/api/probe', { ip: ip, port: port }, function (err, res) {
        if (err) { setStatus('status-badge-error', '✖ ' + err.message); return; }
        if (res.rtsp_protocol_ok) setStatus('status-badge-success', '✔ RTSP Connection Established! Server: ' + res.banner);
        else if (res.port_open) setStatus('status-badge-warning', '⚠ Port ' + port + ' open, but camera RTSP returned: ' + res.banner);
        else setStatus('status-badge-error', '✖ Unreachable: Port ' + port + ' closed on ' + ip);
      });
    };

    // Verify Authentication & Visual Live Check button
    var btnVerify = $('btnVerifyCamera');
    if (btnVerify) {
      btnVerify.onclick = function () {
        var ip = ($('wzIp').value || '').trim();
        var port = parseInt($('wzPort').value || 554, 10) || 554;
        var brand = $('wzBrand').value;
        var user = ($('wzUser').value || '').trim();
        var pass = $('wzPass').value || '';
        var ch = parseInt($('wzChannel').value || 1, 10) || 1;

        if (!ip) {
          showToast('⚠ Please enter camera IP address first.');
          return;
        }

        var path = '/stream2';
        if (brand === 'imou' || brand === 'dahua') path = '/cam/realmonitor?channel=' + ch + '&subtype=1';
        else if (brand === 'hikvision') path = '/Streaming/Channels/' + ((ch * 100) + 2);
        else if (brand === 'reolink') path = '/h264Preview_01_sub';

        var card = $('verificationCard');
        var badge = $('vcAuthBadge');
        var title = $('vcTitle');
        var lineAuth = $('vcLineAuth');
        var lineCodec = $('vcLineCodec');
        var lineAudio = $('vcLineAudio');
        var lineDetails = $('vcLineDetails');
        var hint = $('vcHint');
        var snapImg = $('vcSnapImg');
        var snapOverlay = $('vcSnapOverlay');
        var snapText = $('vcSnapText');

        if (card) {
          card.style.display = 'flex';
          card.className = 'verification-card';
        }
        if (badge) {
          badge.className = 'vc-badge';
          badge.textContent = 'CHECKING...';
        }
        if (title) title.textContent = 'Testing RTSP Handshake & Authentication...';
        if (lineAuth) lineAuth.textContent = 'Verifying credentials with camera...';
        if (lineCodec) lineCodec.textContent = 'Probing video stream...';
        if (lineAudio) lineAudio.textContent = 'Probing audio track...';
        if (lineDetails) lineDetails.textContent = 'Connecting to ' + ip + ':' + port + path;
        if (hint) hint.style.display = 'none';
        if (snapImg) snapImg.style.display = 'none';
        if (snapOverlay) snapOverlay.style.display = 'flex';
        if (snapText) snapText.textContent = '⏳ Authenticating & grabbing live visual snapshot...';

        showToast('Connecting & authenticating with ' + ip + '...');

        // Credentials go in the POST body, never in the URL
        api('POST', '/api/verify_camera', { ip: ip, port: port, brand: brand, user: user, pass: pass, path: path }, function (err, res) {
          if (err && !res) {
            if (card) card.className = 'verification-card is-error';
            if (badge) { badge.className = 'vc-badge is-error'; badge.textContent = '✖ ERROR'; }
            if (lineAuth) lineAuth.textContent = err.message;
            if (snapText) snapText.textContent = '✖ Verification could not run';
            return;
          }
          res = res || {};
          if (res.authenticated) {
            if (card) card.className = 'verification-card is-success';
            if (badge) {
              badge.className = 'vc-badge is-success';
              badge.textContent = '✔ AUTHENTICATED';
            }
            if (title) title.textContent = 'Credentials & Live Stream Verified (200 OK)';
            if (lineAuth) lineAuth.innerHTML = '<span style="color:#30d158; font-weight:700;">✔ Verified (Credentials Accepted)</span>';
            if (lineCodec) lineCodec.textContent = res.video_codec || 'H.264 (AVC)';
            if (lineAudio) lineAudio.textContent = res.audio_codec || 'None';
            if (lineDetails) lineDetails.textContent = res.message || 'Stream Ready';

            if (res.visual_snapshot_url && snapImg) {
              snapImg.onload = function () {
                snapImg.style.display = 'block';
                if (snapOverlay) snapOverlay.style.display = 'none';
              };
              snapImg.onerror = function () {
                if (snapText) snapText.textContent = '✔ Stream active. Snapshot not available yet.';
              };
              snapImg.src = (backendBase() || '') + res.visual_snapshot_url;
            } else if (snapText) {
              snapText.textContent = '✔ Auth verified! Stream ready for playback.';
            }
            showToast('✔ Camera Authenticated & Live View Verified!');
          } else {
            if (card) card.className = 'verification-card is-error';
            if (badge) {
              badge.className = 'vc-badge is-error';
              badge.textContent = '✖ AUTH FAILED';
            }
            if (title) title.textContent = 'Authentication or Connection Rejected';
            if (lineAuth) lineAuth.innerHTML = '<span style="color:#ff453a; font-weight:700;">✖ ' + esc(res.message || 'Authentication Failed') + '</span>';
            if (lineCodec) lineCodec.textContent = '--';
            if (lineAudio) lineAudio.textContent = '--';
            if (lineDetails) lineDetails.textContent = 'Status code: ' + (res.status || 'Error');

            if (snapImg) snapImg.style.display = 'none';
            if (snapOverlay) snapOverlay.style.display = 'flex';
            if (snapText) snapText.textContent = '✖ No Video: Authentication Failed';

            if (hint) {
              if (brand === 'tapo') {
                hint.innerHTML = '💡 <strong>TP-Link Tapo:</strong> Did you create a dedicated <em>Camera Account</em> in the Tapo App (Settings &rarr; Advanced Settings &rarr; Camera Account)? Standard TP-Link cloud account logins are rejected by camera RTSP.';
              } else if (brand === 'imou') {
                hint.innerHTML = '💡 <strong>Imou Bullet:</strong> Username must be <code>admin</code>. Password must be the exact 8-character <strong>Safety Code</strong> printed on the camera sticker near the QR code.';
              } else {
                hint.innerHTML = '💡 <strong>Check Credentials:</strong> Verify username, password, and ensure RTSP/ONVIF is enabled in camera settings.';
              }
              hint.style.display = 'block';
            }
            showToast('✖ Authentication Failed. Check credentials / Safety Code.');
          }
        });
      };
    }

    // Add to Watchlist button
    $('btnAddCamera').onclick = function () {
      if (addCameraFromWizard()) {
        showToast('✔ Camera added to Watchlist!');
        $('wzIp').value = '';
        $('wzPass').value = '';
        $('wzName').value = '';
        updateWizardUrl();
      } else {
        showToast('⚠ Please enter a valid Camera IP Address first.');
      }
    };

    // Clear Demo Cameras button
    var btnClearAll = $('btnClearAllCams');
    if (btnClearAll) {
      btnClearAll.onclick = function () {
        state.cameras = [];
        saveState();
        renderConfiguredList();
        renderGrid();
        showToast('All demo cameras cleared. Add your camera above.');
      };
    }

    // Test Gateway button
    $('btnTestGateway').onclick = function () {
      state.gatewayUrl = ($('cfgGatewayUrl').value || '').trim();
      saveState();
      checkGateway();
      showToast('Testing gateway connection...');
    };

    // Save & Apply button
    $('btnSaveClose').onclick = function () {
      var ipVal = ($('wzIp').value || '').trim();
      var added = false;
      if (ipVal && ipVal !== '192.168.1.100' && ipVal !== '192.168.31.100') {
        added = addCameraFromWizard();
      }

      if ($('cfgGatewayUrl').value) {
        state.gatewayUrl = $('cfgGatewayUrl').value.trim();
      }

      saveState();
      closeModal();

      var msg = added
        ? '✔ Saved & applied ' + state.cameras.length + ' camera(s) to Live Wall!'
        : '✔ Settings applied (' + state.cameras.length + ' camera(s) ready)!';
      showToast(msg);
    };

    // Cancel / Close button
    $('btnCancelClose').onclick = function () {
      closeModal();
    };

    // Header Action Buttons & Remote Pills
    var btnHeadAdd = $('btnHeaderAddCam');
    if (btnHeadAdd) btnHeadAdd.onclick = openModal;

    var btnHeadSet = $('btnHeaderSettings');
    if (btnHeadSet) btnHeadSet.onclick = openModal;

    var pRed = $('pillRed');
    if (pRed) pRed.onclick = function () { handleKey(KEYS.RED); };

    var pYellow = $('pillYellow');
    if (pYellow) pYellow.onclick = function () { handleKey(KEYS.YELLOW); };

    var pBlue = $('pillBlue');
    if (pBlue) pBlue.onclick = openModal;

    function autoScale() {
      var stage = $('stage');
      if (!stage) return;
      var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      stage.style.transform = 'scale(' + scale + ')';
    }

    autoScale();
    window.addEventListener('resize', autoScale);
  }

  window.addEventListener('load', init);
}());
