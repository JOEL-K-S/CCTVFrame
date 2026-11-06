"""CCTVFrame Backend Gateway & Camera Probe Server.
Features:
- Local IP / Subnet Auto-Discovery (mDNS, SSDP, Port Scan on 554, 2020, 37777, 8000, 80).
- RTSP Authentication Handshake (Digest / Basic) & Protocol Verification.
- Visual Live Snapshot Verification Engine.
- Automatic go2rtc Gateway Process Management & Stream Registration.
- Embedded HTTP API & Reverse Proxy for Samsung TV App and Browser Preview.
"""

import base64
import hashlib
import http.server
import ipaddress
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit

PORT = 4800
BIND = os.environ.get('CCTV_BIND', '0.0.0.0')
# Origins allowed to call the API cross-origin. Tizen widgets send "null"; same-origin pages need no entry.
ALLOWED_ORIGINS = set(o.strip() for o in os.environ.get('CCTV_ALLOWED_ORIGINS', 'null').split(',') if o.strip())
MAX_BODY = 256 * 1024
SCAN_LOCK = threading.Lock()


def is_private_host(host):
    """Only loopback / private / link-local literal IPs are accepted as camera targets."""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return addr.is_private or addr.is_loopback or addr.is_link_local


def parse_port(value, default=554):
    try:
        port = int(value)
    except (TypeError, ValueError):
        return default
    return port if 1 <= port <= 65535 else default


def safe_stream_name(name):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', str(name))[:64]


def redact_url(url):
    """Remove user:password from an RTSP URL before persisting it."""
    return re.sub(r'(://)[^/@\s]*@', r'\1', url or '')
BASE_DIR = os.path.join(os.path.dirname(__file__), '..', 'app')
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
BIN_DIR = os.path.join(os.path.dirname(__file__), '..', 'bin')
os.makedirs(DATA_DIR, exist_ok=True)
CAMERAS_FILE = os.path.join(DATA_DIR, 'cameras.json')

STATE = {
    'scanning': False,
    'progress': '',
    'discovered': [],
    'streams': {}
}

GO2RTC_PROC = None


def get_local_ips():
    """Detect private IPv4 addresses of this host without requiring internet access."""
    ips = []

    def add(ip):
        if ip and ip not in ips and not ip.startswith(('127.', '169.254.', '0.')):
            ips.append(ip)

    for target in ('8.8.8.8', '10.255.255.255', '192.168.255.255', '172.16.255.255'):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((target, 80))
            add(s.getsockname()[0])
        except Exception:
            pass
        finally:
            s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except Exception:
        pass
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr'], capture_output=True, text=True, timeout=3).stdout
        for m in re.finditer(r'inet (\d+\.\d+\.\d+\.\d+)', out):
            add(m.group(1))
    except Exception:
        pass
    # Skip Docker's default bridge unless it is the only network found
    real = [i for i in ips if not i.startswith('172.17.')]
    return real or ips


def get_local_ip_range():
    """Return (primary local IP, primary /24 prefix)."""
    ips = get_local_ips()
    if ips:
        parts = ips[0].split('.')
        return ips[0], f"{parts[0]}.{parts[1]}.{parts[2]}."
    return '127.0.0.1', '192.168.1.'


def check_port(ip, port, timeout=0.8):
    """Check if a specific port is open on target IP."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        res = s.connect_ex((ip, port))
        s.close()
        return res == 0
    except Exception:
        return False


def parse_sdp(sdp_text):
    """Extract video and audio codec information from SDP payload."""
    info = {'video_codec': 'H.264', 'audio_codec': 'None'}
    try:
        # Search for video RTP maps (e.g. a=rtpmap:96 H264/90000 or H265/90000)
        v_matches = re.findall(r'a=rtpmap:\d+\s+([A-Za-z0-9\-_]+)', sdp_text, re.IGNORECASE)
        for codec in v_matches:
            c_upper = codec.upper()
            if 'H264' in c_upper:
                info['video_codec'] = 'H.264 (AVC)'
            elif 'H265' in c_upper or 'HEVC' in c_upper:
                info['video_codec'] = 'H.265 (HEVC)'
            elif 'PCMA' in c_upper or 'PCMU' in c_upper or 'G711' in c_upper:
                info['audio_codec'] = 'G.711 / PCM'
            elif 'AAC' in c_upper:
                info['audio_codec'] = 'AAC Audio'
    except Exception:
        pass
    return info


def verify_rtsp_auth(ip, port, path, username, password, timeout=3.0):
    """
    Executes standard RTSP DESCRIBE with RFC 2617 Digest or Basic Authentication.
    Returns: (authenticated: bool, status_code: int, message: str, sdp_info: dict)
    """
    if not path.startswith('/'):
        path = '/' + path

    uri = f"rtsp://{ip}:{port}{path}"
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)

    try:
        s.connect((ip, port))

        # 1. Unauthenticated DESCRIBE probe to receive 401 challenge
        cseq = 1
        req1 = (
            f"DESCRIBE {uri} RTSP/1.0\r\n"
            f"CSeq: {cseq}\r\n"
            f"Accept: application/sdp\r\n"
            f"User-Agent: CCTVFrame/2.0\r\n\r\n"
        )
        s.sendall(req1.encode('utf-8'))
        resp1 = s.recv(4096).decode('utf-8', errors='ignore')

        if 'RTSP/1.0 200 OK' in resp1:
            s.close()
            return True, 200, "Authentication Successful (Open feed - no password required)", parse_sdp(resp1)

        if 'RTSP/1.0 401' in resp1 or '401 Unauthorized' in resp1:
            if not username or not password:
                s.close()
                return False, 401, "Camera requires Authentication. Please enter Username & Password / Safety Code.", {}

            m_auth = re.search(r'WWW-Authenticate:\s*([^\r\n]+)', resp1, re.IGNORECASE)
            if not m_auth:
                s.close()
                return False, 401, "Camera returned 401 Unauthorized without WWW-Authenticate challenge header", {}

            challenge = m_auth.group(1).strip()
            auth_str = ""

            if challenge.lower().startswith('digest'):
                realm_m = re.search(r'realm="([^"]+)"', challenge, re.IGNORECASE)
                nonce_m = re.search(r'nonce="([^"]+)"', challenge, re.IGNORECASE)
                realm = realm_m.group(1) if realm_m else ""
                nonce = nonce_m.group(1) if nonce_m else ""

                ha1 = hashlib.md5(f"{username}:{realm}:{password}".encode('utf-8')).hexdigest()
                ha2 = hashlib.md5(f"DESCRIBE:{uri}".encode('utf-8')).hexdigest()
                response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode('utf-8')).hexdigest()

                auth_str = f'Digest username="{username}", realm="{realm}", nonce="{nonce}", uri="{uri}", response="{response}"'
            elif challenge.lower().startswith('basic'):
                token = base64.b64encode(f"{username}:{password}".encode('utf-8')).decode('ascii')
                auth_str = f"Basic {token}"
            else:
                s.close()
                return False, 401, f"Unsupported authentication type: {challenge}", {}

            # 2. Authenticated DESCRIBE request
            cseq += 1
            req2 = (
                f"DESCRIBE {uri} RTSP/1.0\r\n"
                f"CSeq: {cseq}\r\n"
                f"Authorization: {auth_str}\r\n"
                f"Accept: application/sdp\r\n"
                f"User-Agent: CCTVFrame/2.0\r\n\r\n"
            )
            s.sendall(req2.encode('utf-8'))
            resp2 = s.recv(4096).decode('utf-8', errors='ignore')
            s.close()

            if 'RTSP/1.0 200 OK' in resp2:
                sdp_info = parse_sdp(resp2)
                return True, 200, "Authentication Verified! Credentials accepted by camera.", sdp_info
            elif 'RTSP/1.0 401' in resp2 or '401' in resp2:
                return False, 401, "Authentication FAILED: Invalid Username or Password / Safety Code.", {}
            elif '404' in resp2:
                return False, 404, f"Authentication passed, but stream path '{path}' was not found (404).", {}
            else:
                first_line = resp2.split('\r\n')[0] if resp2 else 'No response'
                return False, 500, f"Camera response: {first_line}", {}
        else:
            s.close()
            first_line = resp1.split('\r\n')[0] if resp1 else 'Unknown response'
            return False, 500, f"Unexpected camera response: {first_line}", {}

    except socket.timeout:
        return False, 408, f"Timeout connecting to {ip}:{port}", {}
    except ConnectionRefusedError:
        return False, 111, f"Connection refused on port {port}. RTSP service may be disabled on camera.", {}
    except Exception as e:
        return False, 500, f"RTSP Handshake Error: {str(e)}", {}


def run_subnet_discovery():
    """Scan local subnet for devices with open RTSP (554), ONVIF (80, 2020, 8000), or Dahua/Imou (37777) ports."""
    STATE['scanning'] = True
    STATE['discovered'] = []
    local_ips = get_local_ips()
    prefixes = []
    for ip in local_ips:
        p = '.'.join(ip.split('.')[:3]) + '.'
        if p not in prefixes:
            prefixes.append(p)
    if not prefixes:
        prefixes = ['192.168.1.']
    STATE['progress'] = f"Scanning subnet(s) {', '.join(x + '0/24' for x in prefixes)} on camera ports..."

    found = []

    def probe_host(host_ip):
        has_rtsp = check_port(host_ip, 554)
        has_tapo_onvif = check_port(host_ip, 2020)
        has_dahua_imou = check_port(host_ip, 37777)
        has_hikvision = check_port(host_ip, 8000)
        has_onvif = check_port(host_ip, 8899)
        has_http = check_port(host_ip, 80)

        if has_rtsp or has_tapo_onvif or has_dahua_imou or has_hikvision or has_onvif:
            brand = "Generic Camera"
            banner = 'Port Open'
            rtsp_ok = False

            if has_rtsp:
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.settimeout(1.2)
                    s.connect((host_ip, 554))
                    s.sendall(f"OPTIONS rtsp://{host_ip}:554 RTSP/1.0\r\nCSeq: 1\r\n\r\n".encode('utf-8'))
                    resp = s.recv(1024).decode('utf-8', errors='ignore')
                    s.close()
                    if 'RTSP/1.0' in resp:
                        rtsp_ok = True
                        m = re.search(r'Server:\s*([^\r\n]+)', resp, re.IGNORECASE)
                        if m:
                            banner = m.group(1).strip()
                except Exception:
                    pass

            banner_lower = banner.lower()
            if has_tapo_onvif or 'tapo' in banner_lower or 'tp-link' in banner_lower:
                brand = 'TP-Link Tapo Camera'
            elif has_dahua_imou or 'imou' in banner_lower:
                brand = 'Imou WiFi Bullet Camera'
            elif 'dahua' in banner_lower or 'realmonitor' in banner_lower:
                brand = 'Dahua / CP Plus Camera'
            elif has_hikvision or 'hikvision' in banner_lower:
                brand = 'Hikvision Camera/NVR'
            elif 'reolink' in banner_lower:
                brand = 'Reolink Camera'

            device = {
                'ip': host_ip,
                'ports': {
                    'rtsp': has_rtsp,
                    'tapo_2020': has_tapo_onvif,
                    'dahua_37777': has_dahua_imou,
                    'hik_8000': has_hikvision,
                    'http': has_http
                },
                'brand': brand,
                'banner': banner,
                'rtsp_verified': rtsp_ok,
                'tested_at': time.strftime('%H:%M:%S')
            }
            found.append(device)

    try:
        hosts = [f"{x}{i}" for x in prefixes for i in range(1, 255) if f"{x}{i}" not in local_ips]
        with ThreadPoolExecutor(max_workers=100) as pool:
            list(pool.map(probe_host, hosts))
        STATE['discovered'] = found
        STATE['progress'] = f"Found {len(found)} camera/NVR device(s) on local network."
    except Exception as e:
        STATE['progress'] = f"Scan failed: {e}"
    finally:
        STATE['scanning'] = False


def start_go2rtc():
    """Ensure go2rtc gateway is running."""
    global GO2RTC_PROC
    bin_path = os.path.join(BIN_DIR, 'go2rtc.exe')
    cfg_path = os.path.join(BIN_DIR, 'go2rtc.yaml')

    if not os.path.exists(bin_path):
        return None

    if check_port('127.0.0.1', 1984):
        return None

    try:
        cmd = [bin_path]
        if os.path.exists(cfg_path):
            cmd.extend(['-c', cfg_path])
        GO2RTC_PROC = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"[Gateway] go2rtc started (PID {GO2RTC_PROC.pid}) on port 1984")
        return GO2RTC_PROC
    except Exception as e:
        print("[Gateway] Error launching go2rtc:", e)
        return None


def register_stream_in_go2rtc(stream_name, rtsp_url):
    """Register or update a stream in go2rtc via REST API."""
    if not stream_name or not rtsp_url:
        return False
    try:
        target_url = f"http://127.0.0.1:1984/api/streams?dst={urllib.parse.quote(stream_name)}&src={urllib.parse.quote(rtsp_url)}"
        req = urllib.request.Request(target_url, method='PUT')
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status in (200, 201)
    except Exception:
        return False


def unregister_stream_in_go2rtc(stream_name):
    """Remove a temporary stream from go2rtc."""
    try:
        target_url = f"http://127.0.0.1:1984/api/streams?src={urllib.parse.quote(stream_name)}"
        req = urllib.request.Request(target_url, method='DELETE')
        with urllib.request.urlopen(req, timeout=2):
            pass
    except Exception:
        pass


def probe_rtsp_options(ip, port, timeout=2.0):
    """Unauthenticated RTSP OPTIONS probe. Returns (port_open, rtsp_ok, banner)."""
    if not check_port(ip, port):
        return False, False, 'Port closed'
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, port))
        s.sendall(f"OPTIONS rtsp://{ip}:{port} RTSP/1.0\r\nCSeq: 1\r\n\r\n".encode('utf-8'))
        resp = s.recv(1024).decode('utf-8', errors='ignore')
        if 'RTSP/1.0' in resp:
            m = re.search(r'Server:\s*([^\r\n]+)', resp, re.IGNORECASE)
            return True, True, (m.group(1).strip() if m else 'RTSP service responded')
        return True, False, 'Port open but no RTSP response'
    except Exception as e:
        return True, False, f'No RTSP response ({e.__class__.__name__})'
    finally:
        s.close()


class CCTVHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    # ---- helpers ----
    def _cors_origin(self):
        origin = self.headers.get('Origin')
        return origin if origin and origin in ALLOWED_ORIGINS else None

    def _send_headers(self, status, content_type='application/json', length=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.end_headers()

    def _json(self, status, obj):
        body = json.dumps(obj).encode('utf-8')
        self._send_headers(status, 'application/json', len(body))
        self.wfile.write(body)

    def _client_allowed(self):
        """The API is for the local network only."""
        try:
            return is_private_host(self.client_address[0].split('%')[0])
        except Exception:
            return False

    def _origin_allowed(self):
        origin = self.headers.get('Origin')
        if not origin:
            return True
        if origin in ALLOWED_ORIGINS:
            return True
        host = self.headers.get('Host', '')
        return origin in ('http://' + host, 'https://' + host)

    def _guard(self):
        if not self._client_allowed():
            self._json(403, {'status': 'error', 'message': 'Forbidden: local network clients only.'})
            return False
        if not self._origin_allowed():
            self._json(403, {'status': 'error', 'message': 'Forbidden origin.'})
            return False
        return True

    def _read_json(self):
        ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if ctype != 'application/json':
            self._json(415, {'status': 'error', 'message': 'Content-Type must be application/json.'})
            return None
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self._json(413, {'status': 'error', 'message': 'Request too large.'})
            return None
        try:
            return json.loads((self.rfile.read(length) if length > 0 else b'{}').decode('utf-8'))
        except ValueError:
            self._json(400, {'status': 'error', 'message': 'Invalid JSON.'})
            return None

    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(204)
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    # ---- GET ----
    def do_GET(self):
        url = urlsplit(self.path)

        if url.path.startswith('/api/') and not self._guard():
            return

        if url.path == '/api/discovery':
            self._json(200, {
                'scanning': STATE['scanning'],
                'progress': STATE['progress'],
                'discovered': STATE['discovered']
            })
            return

        # Reverse proxy for JPEG snapshots from go2rtc
        if url.path == '/api/frame.jpeg':
            src = safe_stream_name(parse_qs(url.query).get('src', [''])[0])
            if src:
                try:
                    target = f"http://127.0.0.1:1984/api/frame.jpeg?src={urllib.parse.quote(src)}"
                    with urllib.request.urlopen(urllib.request.Request(target), timeout=3.5) as resp:
                        data = resp.read()
                    self._send_headers(200, 'image/jpeg', len(data))
                    self.wfile.write(data)
                    return
                except Exception:
                    pass
            self.send_error(404, 'Frame not available from camera gateway')
            return

        if url.path == '/api/cameras':
            cams = []
            if os.path.exists(CAMERAS_FILE):
                try:
                    with open(CAMERAS_FILE, 'r', encoding='utf-8') as f:
                        cams = json.load(f)
                except Exception:
                    pass
            self._json(200, {'cameras': cams})
            return

        if url.path.startswith('/api/'):
            self.send_error(404, 'Endpoint not found')
            return

        super().do_GET()

    # ---- POST ----
    def do_POST(self):
        url = urlsplit(self.path)
        if not url.path.startswith('/api/'):
            self.send_error(404, 'Endpoint not found')
            return
        if not self._guard():
            return

        data = self._read_json()
        if data is None:
            return
        if not isinstance(data, (dict, list)):
            self._json(400, {'status': 'error', 'message': 'Invalid payload.'})
            return

        if url.path == '/api/scan':
            if STATE['scanning']:
                self._json(200, {'status': 'scan_running'})
                return
            STATE['scanning'] = True
            STATE['progress'] = 'Starting scan...'
            threading.Thread(target=run_subnet_discovery, daemon=True).start()
            self._json(200, {'status': 'scan_started'})
            return

        if url.path == '/api/probe':
            ip = str(data.get('ip', '')).strip() if isinstance(data, dict) else ''
            port = parse_port(data.get('port') if isinstance(data, dict) else None)
            if not is_private_host(ip):
                self._json(400, {'status': 'error', 'message': 'Enter a valid local IP address.'})
                return
            port_open, rtsp_ok, banner = probe_rtsp_options(ip, port)
            self._json(200, {'ip': ip, 'port': port, 'port_open': port_open, 'rtsp_protocol_ok': rtsp_ok, 'banner': banner})
            return

        if url.path == '/api/verify_camera':
            self._verify_camera(data if isinstance(data, dict) else {})
            return

        if url.path in ('/api/cameras', '/api/sync_streams'):
            self._sync_cameras(data)
            return

        self.send_error(404, 'Endpoint not found')

    def _verify_camera(self, q):
        ip = str(q.get('ip', '')).strip()
        port = parse_port(q.get('port'))
        path = str(q.get('path', '/stream2')).strip()
        user = str(q.get('user', '')).strip()
        passwd = str(q.get('pass', ''))

        if not is_private_host(ip):
            self._json(400, {'authenticated': False, 'status': 400, 'message': 'Enter a valid local camera IP address.'})
            return

        if not check_port(ip, port):
            self._json(200, {
                'authenticated': False,
                'port_open': False,
                'status': 111,
                'message': f"Port {port} is closed or unreachable on {ip}. Ensure camera is powered on and connected to WiFi."
            })
            return

        auth_ok, status_code, message, sdp_info = verify_rtsp_auth(ip, port, path, user, passwd)

        visual_snapshot_url = ""
        if auth_ok:
            path_part = path if path.startswith('/') else '/' + path
            auth_part = f"{urllib.parse.quote(user, safe='')}:{urllib.parse.quote(passwd, safe='')}@" if user else ""
            full_rtsp = f"rtsp://{auth_part}{ip}:{port}{path_part}"
            temp_stream = f"probe_verify_{int(time.time() * 1000)}"
            if register_stream_in_go2rtc(temp_stream, full_rtsp):
                time.sleep(0.6)
                visual_snapshot_url = f"/api/frame.jpeg?src={temp_stream}&t={time.time()}"
                # Remove the temporary stream (and its credentials) once the preview has been fetched
                threading.Timer(30, unregister_stream_in_go2rtc, args=(temp_stream,)).start()

        self._json(200, {
            'ip': ip,
            'port': port,
            'port_open': True,
            'authenticated': auth_ok,
            'status': status_code,
            'message': message,
            'video_codec': sdp_info.get('video_codec', 'H.264'),
            'audio_codec': sdp_info.get('audio_codec', 'None'),
            'visual_snapshot_url': visual_snapshot_url,
            'timestamp': time.time()
        })

    def _sync_cameras(self, data):
        cameras = data if isinstance(data, list) else data.get('cameras', [])
        if not isinstance(cameras, list):
            self._json(400, {'status': 'error', 'message': 'cameras must be a list.'})
            return

        synced_count = 0
        stored = []
        for cam in cameras:
            if not isinstance(cam, dict):
                continue
            s_name = safe_stream_name(cam.get('streamName') or f"cam_{cam.get('id', 'stream')}")
            rtsp = cam.get('url') or cam.get('rtspUrl')
            # Credentials are only used to register the stream in memory and never written to disk
            entry = {k: v for k, v in cam.items() if k not in ('pass', 'user', 'password', 'rtspUrl')}
            entry['streamName'] = s_name
            entry['url'] = redact_url(rtsp)
            stored.append(entry)
            if rtsp and isinstance(rtsp, str) and rtsp.startswith('rtsp://'):
                if register_stream_in_go2rtc(s_name, rtsp):
                    synced_count += 1

        try:
            with open(CAMERAS_FILE, 'w', encoding='utf-8') as f:
                json.dump(stored, f, indent=2)
        except OSError as e:
            self._json(500, {'status': 'error', 'message': str(e)})
            return

        self._json(200, {'status': 'ok', 'synced': synced_count, 'total': len(stored)})


if __name__ == '__main__':
    start_go2rtc()
    local_ip, _ = get_local_ip_range()
    server = http.server.ThreadingHTTPServer((BIND, PORT), CCTVHandler)
    print("=====================================================")
    print(" CCTVFrame Backend Engine & Camera Gateway Running ")
    print(f" Local Web Preview: http://127.0.0.1:{PORT}/")
    print(f" LAN IP for Samsung TV: http://{local_ip}:{PORT}/")
    print(" go2rtc Streaming Gateway: http://127.0.0.1:1984/")
    print("=====================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if GO2RTC_PROC:
            GO2RTC_PROC.terminate()
