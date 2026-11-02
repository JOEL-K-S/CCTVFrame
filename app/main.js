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
      var streamId = (ch * 100) + 2; // e.g. Channel 1 sub-stream = 102
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + '/Streaming/Channels/' + streamId;
    },
    dahua: function (c) {
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + '/cam/realmonitor?channel=' + (c.channel || 1) + '&subtype=1';
    },
    reolink: function (c) {
      return 'rtsp://' + (c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' : '') + c.ip + ':' + (c.port || 554) + '/h264Preview_01_sub';
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
    if (!state.cameras || state.cameras.length === 0) return;
    var payload = state.cameras.map(function (c) {
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

    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/sync_streams', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    } catch (e) { }
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

  function getStreamUrl(cam, forceSub) {
    if (!cam) return '';
    // 1. Direct RTSP URL computation
    if (cam.brand && BRAND_PRESETS[cam.brand]) {
      var clone = {
        ip: cam.ip,
        port: cam.port || 554,
        user: cam.user || '',
        pass: cam.pass || '',
        channel: cam.channel || 1,
        subtype: forceSub ? 'sub' : (cam.subtype || 'sub')
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
    if (state.cameras.length === 2 && state.gridMode === 2) {
      effectiveGrid = 2;
    }

    wall.className = 'grid-wall grid-' + effectiveGrid;
    wall.innerHTML = '';

    var count = Math.min(effectiveGrid, state.cameras.length);

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
        '<img class="tile-snapshot" id="snap-' + i + '" alt="' + cam.name + '">',
        '<div class="tile-placeholder" id="ph-' + i + '"><span class="ph-icon">📹</span><span>' + (cam.brand ? cam.brand.toUpperCase() : 'RTSP') + ' Stream Ready</span></div>',
        '<div class="tile-overlay">',
        '<span class="tile-name">' + cam.name + '</span>',
        '<span class="status-chip status-snap" id="chip-' + i + '">LIVE</span>',
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
      addTile.id = 'tile-add';
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
    if (state.isFullscreen || state.isModalOpen) return;

    var count = Math.min(state.gridMode, state.cameras.length);
    for (var i = 0; i < count; i++) {
      var cam = state.cameras[i];
      var img = $('snap-' + i);
      if (img && cam) {
        var url = getSnapshotUrl(cam);
        if (url) {
          img.src = url;
          var chip = $('chip-' + i);
          if (chip) chip.className = 'status-chip status-snap';
        }
      }
    }

    state.snapshotTimer = setTimeout(refreshSnapshots, 2500);
  }

  function setFocus(newIndex) {
    var count = Math.min(state.gridMode, state.cameras.length);
    if (newIndex < 0 || newIndex >= count) return;

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

    var fsView = $('fullscreenView');
    if (fsView) {
      fsView.hidden = false;
      fsView.style.display = 'flex';
      fsView.classList.remove('is-hidden');
    }

    $('fsHudName').textContent = cam.name;
    showHud();

    var directRtsp = getStreamUrl(cam, false);
    var gatewayUrl = getGatewayPlayUrl(cam);
    var video = $('fsVideoPlayer');

    if (directRtsp.indexOf('rtsp://') === 0 && state.hasAvplay) {
      video.style.display = 'none';
      playAvplay(directRtsp);
      $('fsHudCodec').textContent = 'AVPlay Native RTSP';
    } else {
      if (state.hasAvplay) stopAvplay();
      video.style.display = 'block';
      video.src = gatewayUrl;
      video.play().catch(function () {});
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
      video.pause();
      video.src = '';
    }

    if (state.hasAvplay) stopAvplay();

    showHud(false);
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

  function handleKey(code) {
    if (state.isModalOpen) {
      if (code === KEYS.BACK || code === KEYS.ESC) closeModal();
      return;
    }

    // Keyboard shortcuts for PC preview: A / S / B / +
    if (!state.isFullscreen && (code === 65 || code === 83 || code === 66 || code === 187 || code === 107)) {
      openModal();
      return;
    }

    if (state.isFullscreen) {
      if (code === KEYS.BACK || code === KEYS.ESC) {
        closeFullscreen();
      } else if (code === KEYS.LEFT) {
        var prevIdx = (state.focusedIndex - 1 + state.cameras.length) % state.cameras.length;
        openFullscreen(prevIdx);
      } else if (code === KEYS.RIGHT) {
        var nextIdx = (state.focusedIndex + 1) % state.cameras.length;
        openFullscreen(nextIdx);
      } else if (code === KEYS.ENTER) {
        showHud();
      }
      return;
    }

    var cols = state.gridMode === 6 ? 3 : (state.gridMode === 4 || state.gridMode === 2 ? 2 : 1);
    var count = Math.min(state.gridMode, state.cameras.length);

    if (code === KEYS.LEFT) {
      if (state.focusedIndex % cols > 0) setFocus(state.focusedIndex - 1);
    } else if (code === KEYS.RIGHT) {
      if (state.focusedIndex % cols < cols - 1 && state.focusedIndex + 1 < count) setFocus(state.focusedIndex + 1);
    } else if (code === KEYS.UP) {
      if (state.focusedIndex >= cols) setFocus(state.focusedIndex - cols);
    } else if (code === KEYS.DOWN) {
      if (state.focusedIndex + cols < count) setFocus(state.focusedIndex + cols);
    } else if (code === KEYS.ENTER) {
      openFullscreen(state.focusedIndex);
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
      $('wzGeneratedUrl').value = gen;
    }
  }

  function addCameraFromWizard() {
    var brand = $('wzBrand').value;
    var ip = ($('wzIp').value || '').trim();
    if (!ip) return false;

    // If currently only demo cameras exist, clear them so the user's real camera is first
    if (isOnlyDemoCameras()) {
      state.cameras = [];
    }

    var customName = ($('wzName') && $('wzName').value || '').trim();
    var brandLabel = $('wzBrand').options[$('wzBrand').selectedIndex].text.split(' ')[0];
    var name = customName || (brandLabel + ' Camera ' + (state.cameras.length + 1));

    // Check if camera with this IP already exists in watchlist
    var existingIdx = -1;
    for (var i = 0; i < state.cameras.length; i++) {
      if (state.cameras[i].ip === ip) {
        existingIdx = i;
        break;
      }
    }

    var sId = existingIdx >= 0 ? state.cameras[existingIdx].id : ('cam_' + Date.now());
    var sName = 'cam_' + brand + '_' + (existingIdx >= 0 ? existingIdx + 1 : (state.cameras.length + 1));

    var camData = {
      id: sId,
      name: name,
      brand: brand,
      ip: ip,
      port: parseInt($('wzPort').value || 554, 10),
      channel: parseInt($('wzChannel').value || 1, 10),
      user: ($('wzUser').value || '').trim(),
      pass: ($('wzPass').value || '').trim(),
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
        '<div class="cam-config-name">' + (idx + 1) + '. ' + c.name + badge + '</div>',
        '<div class="cam-config-url">' + getStreamUrl(c) + '</div>',
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
    renderConfiguredList();
    updateWizardUrl();
  }

  function closeModal() {
    state.isModalOpen = false;
    var modal = $('settingsModal');
    if (modal) {
      modal.hidden = true;
      modal.style.display = 'none';
      modal.classList.add('is-hidden');
    }
    renderGrid();
    checkGateway();
  }

  /* ---------- Clock & Registration ---------- */

  function updateClock() {
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

    setTimeout(updateClock, 1000);
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
    renderGrid();
    checkGateway();

    // Keydown Listener
    document.addEventListener('keydown', function (e) {
      handleKey(e.keyCode);
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

    // Backend Discovery & Handshake Probe Handlers
    var discoveryPoller = null;

    function pollDiscovery() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/discovery', true);
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            var statusEl = $('probeStatus');
            var listEl = $('discoveredList');

            if (data.scanning) {
              if (statusEl) statusEl.innerHTML = '<span class="status-badge-loading">⏳ ' + (data.progress || 'Scanning local subnet...') + '</span>';
              discoveryPoller = setTimeout(pollDiscovery, 1200);
            } else {
              if (statusEl) statusEl.innerHTML = '<span class="status-badge-success">✔ ' + (data.progress || 'Scan complete.') + '</span>';
              if (data.discovered && data.discovered.length > 0 && listEl) {
                listEl.style.display = 'flex';
                listEl.innerHTML = '<div style="font-weight:700; color:#ffd32a; margin-top:8px;">Discovered Devices (Click to autofill):</div>';
                data.discovered.forEach(function (dev) {
                  var item = document.createElement('div');
                  item.className = 'cam-config-item';
                  item.style.cursor = 'pointer';
                  item.innerHTML = [
                    '<div style="overflow:hidden;">',
                    '<div class="cam-config-name">📷 ' + dev.brand + ' (' + dev.ip + ')</div>',
                    '<div class="cam-config-url">RTSP 554: ' + (dev.ports.rtsp ? 'OPEN' : 'CLOSED') + ' | ' + dev.banner + '</div>',
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
            }
          } catch (e) {}
        }
      };
      xhr.send();
    }

    $('btnRunDiscovery').onclick = function () {
      var statusEl = $('probeStatus');
      if (statusEl) statusEl.innerHTML = '<span class="status-badge-loading">🚀 Initiating subnet camera discovery...</span>';
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/scan', true);
      xhr.onload = function () {
        pollDiscovery();
      };
      xhr.send();
    };

    $('btnTestProbe').onclick = function () {
      var ip = $('wzIp').value || '192.168.1.100';
      var port = $('wzPort').value || 554;
      var statusEl = $('probeStatus');
      if (statusEl) statusEl.innerHTML = '<span class="status-badge-loading">⏳ Connecting to ' + ip + ':' + port + ' via RTSP handshake...</span>';

      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/probe?ip=' + encodeURIComponent(ip) + '&port=' + encodeURIComponent(port), true);
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var res = JSON.parse(xhr.responseText);
            if (res.rtsp_protocol_ok) {
              if (statusEl) statusEl.innerHTML = '<span class="status-badge-success">✔ RTSP Connection Established! Server: ' + res.banner + '</span>';
            } else if (res.port_open) {
              if (statusEl) statusEl.innerHTML = '<span class="status-badge-warning">⚠ Port ' + port + ' open, but camera RTSP returned: ' + res.banner + '</span>';
            } else {
              if (statusEl) statusEl.innerHTML = '<span class="status-badge-error">✖ Unreachable: Port ' + port + ' closed on ' + ip + '</span>';
            }
          } catch (e) {}
        }
      };
      xhr.send();
    };

    // Verify Authentication & Visual Live Check button
    var btnVerify = $('btnVerifyCamera');
    if (btnVerify) {
      btnVerify.onclick = function () {
        var ip = ($('wzIp').value || '').trim();
        var port = parseInt($('wzPort').value || 554, 10);
        var brand = $('wzBrand').value;
        var user = ($('wzUser').value || '').trim();
        var pass = ($('wzPass').value || '').trim();
        var ch = parseInt($('wzChannel').value || 1, 10);

        if (!ip) {
          showToast('⚠ Please enter camera IP address first.');
          return;
        }

        var path = '/stream2';
        if (brand === 'tapo') path = '/stream2';
        else if (brand === 'imou' || brand === 'dahua') path = '/cam/realmonitor?channel=' + ch + '&subtype=1';
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

        var query = [
          'ip=' + encodeURIComponent(ip),
          'port=' + encodeURIComponent(port),
          'brand=' + encodeURIComponent(brand),
          'user=' + encodeURIComponent(user),
          'pass=' + encodeURIComponent(pass),
          'path=' + encodeURIComponent(path)
        ].join('&');

        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/verify_camera?' + query, true);
        xhr.onload = function () {
          if (xhr.status === 200) {
            try {
              var res = JSON.parse(xhr.responseText);
              if (res.authenticated) {
                if (card) card.className = 'verification-card is-success';
                if (badge) {
                  badge.className = 'vc-badge is-success';
                  badge.textContent = '✔ AUTHENTICATED';
                }
                if (title) title.textContent = 'Credentials & Live Stream Verified (200 OK)';
                if (lineAuth) lineAuth.innerHTML = '<span style="color:#2ed573; font-weight:700;">✔ Verified (Credentials Accepted)</span>';
                if (lineCodec) lineCodec.textContent = res.video_codec || 'H.264 (AVC)';
                if (lineAudio) lineAudio.textContent = res.audio_codec || 'None';
                if (lineDetails) lineDetails.textContent = res.message || 'Stream Ready';

                if (res.visual_snapshot_url) {
                  if (snapImg) {
                    snapImg.src = res.visual_snapshot_url;
                    snapImg.onload = function () {
                      snapImg.style.display = 'block';
                      if (snapOverlay) snapOverlay.style.display = 'none';
                    };
                    snapImg.onerror = function () {
                      if (snapText) snapText.textContent = '✔ Stream active. Decoding live snapshot...';
                    };
                  }
                } else {
                  if (snapText) snapText.textContent = '✔ Auth verified! Stream ready for playback.';
                }
                showToast('✔ Camera Authenticated & Live View Verified!');
              } else {
                if (card) card.className = 'verification-card is-error';
                if (badge) {
                  badge.className = 'vc-badge is-error';
                  badge.textContent = '✖ AUTH FAILED';
                }
                if (title) title.textContent = 'Authentication or Connection Rejected';
                if (lineAuth) lineAuth.innerHTML = '<span style="color:#ff4757; font-weight:700;">✖ ' + (res.message || 'Authentication Failed') + '</span>';
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
            } catch (e) {
              if (lineAuth) lineAuth.textContent = 'Error parsing probe response.';
            }
          }
        };
        xhr.onerror = function () {
          if (lineAuth) lineAuth.textContent = 'Network error connecting to backend.';
        };
        xhr.send();
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
      state.gatewayUrl = $('cfgGatewayUrl').value;
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
