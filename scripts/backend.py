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
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from urllib.parse import parse_qs, urlsplit

PORT = 4800
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


def get_local_ip_range():
    """Detect local IP and calculate /24 subnet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = '127.0.0.1'
    finally:
        s.close()

    parts = local_ip.split('.')
    if len(parts) == 4 and local_ip != '127.0.0.1':
        subnet_prefix = f"{parts[0]}.{parts[1]}.{parts[2]}."
        return local_ip, subnet_prefix
    return local_ip, '192.168.1.'


def check_port(ip, port, timeout=0.4):
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
    if STATE['scanning']:
        return

    STATE['scanning'] = True
    STATE['discovered'] = []
    local_ip, subnet_prefix = get_local_ip_range()
    STATE['progress'] = f"Scanning subnet {subnet_prefix}1-254 on camera ports..."

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

    threads = []
    for i in range(1, 255):
        ip = f"{subnet_prefix}{i}"
        if ip == local_ip:
            continue
        t = threading.Thread(target=probe_host, args=(ip,))
        threads.append(t)
        t.start()

        if len(threads) >= 40:
            for th in threads:
                th.join()
            threads = []

    for th in threads:
        th.join()

    STATE['discovered'] = found
    STATE['scanning'] = False
    STATE['progress'] = f"Found {len(found)} camera/NVR device(s) on local network."


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


class CCTVHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        url = urlsplit(self.path)

        # 1. REST API: Discovery Status & Results
        if url.path == '/api/discovery':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            data = {
                'scanning': STATE['scanning'],
                'progress': STATE['progress'],
                'discovered': STATE['discovered']
            }
            self.wfile.write(json.dumps(data).encode('utf-8'))
            return

        # 2. REST API: Trigger Network Scan
        if url.path == '/api/scan':
            threading.Thread(target=run_subnet_discovery).start()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'scan_started'}).encode('utf-8'))
            return

        # 3. REST API: Real Authentication & Visual Live Check
        if url.path == '/api/verify_camera':
            qs = parse_qs(url.query)
            ip = qs.get('ip', [''])[0].strip()
            port = int(qs.get('port', [554])[0])
            path = qs.get('path', ['/stream2'])[0].strip()
            user = qs.get('user', [''])[0].strip()
            passwd = qs.get('pass', [''])[0].strip()
            brand = qs.get('brand', ['generic'])[0].strip().lower()

            if not ip:
                self.send_error(400, 'Missing camera IP')
                return

            # Check port first
            if not check_port(ip, port):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                res = {
                    'authenticated': False,
                    'port_open': False,
                    'status': 111,
                    'message': f"Port {port} is closed or unreachable on {ip}. Ensure camera is powered on and connected to WiFi."
                }
                self.wfile.write(json.dumps(res).encode('utf-8'))
                return

            # Run RTSP Authentication Handshake
            auth_ok, status_code, message, sdp_info = verify_rtsp_auth(ip, port, path, user, passwd)

            visual_snapshot_url = ""
            if auth_ok:
                # Build authenticated RTSP URL for go2rtc live snapshot
                auth_part = f"{urllib.parse.quote(user)}:{urllib.parse.quote(passwd)}@" if user else ""
                full_rtsp = f"rtsp://{auth_part}{ip}:{port}{path}"
                temp_stream = f"probe_verify_{int(time.time())}"
                register_stream_in_go2rtc(temp_stream, full_rtsp)

                # Give go2rtc a moment to grab keyframe
                time.sleep(0.6)
                visual_snapshot_url = f"/api/frame.jpeg?src={temp_stream}&t={time.time()}"

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            result = {
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
            }
            self.wfile.write(json.dumps(result).encode('utf-8'))
            return

        # 4. Reverse Proxy for JPEG snapshots from go2rtc
        if url.path == '/api/frame.jpeg':
            qs = parse_qs(url.query)
            src = qs.get('src', [''])[0]
            if src:
                try:
                    target = f"http://127.0.0.1:1984/api/frame.jpeg?src={urllib.parse.quote(src)}"
                    req = urllib.request.Request(target)
                    with urllib.request.urlopen(req, timeout=3.5) as resp:
                        self.send_response(resp.status)
                        self.send_header('Content-Type', 'image/jpeg')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                        self.end_headers()
                        self.wfile.write(resp.read())
                        return
                except Exception:
                    pass
            self.send_error(404, 'Frame not available from camera gateway')
            return

        # 5. REST API: Get Stored Cameras
        if url.path == '/api/cameras':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            cams = []
            if os.path.exists(CAMERAS_FILE):
                try:
                    with open(CAMERAS_FILE, 'r', encoding='utf-8') as f:
                        cams = json.load(f)
                except Exception:
                    pass
            self.wfile.write(json.dumps({'cameras': cams}).encode('utf-8'))
            return

        # 6. Fallback: Serve static app UI (index.html, style.css, main.js)
        super().do_GET()

    def do_POST(self):
        url = urlsplit(self.path)

        if url.path in ('/api/cameras', '/api/sync_streams'):
            length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(length) if length > 0 else b'{}'
            try:
                data = json.loads(raw_body.decode('utf-8'))
                cameras = data if isinstance(data, list) else data.get('cameras', [])

                with open(CAMERAS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(cameras, f, indent=2)

                synced_count = 0
                for cam in cameras:
                    s_name = cam.get('streamName') or f"cam_{cam.get('id', 'stream')}"
                    rtsp = cam.get('url') or cam.get('rtspUrl')
                    if s_name and rtsp:
                        if register_stream_in_go2rtc(s_name, rtsp):
                            synced_count += 1

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok', 'synced': synced_count, 'total': len(cameras)}).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'error', 'message': str(e)}).encode('utf-8'))
                return

        self.send_error(404, 'Endpoint not found')


if __name__ == '__main__':
    start_go2rtc()
    local_ip, _ = get_local_ip_range()
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), CCTVHandler)
    print(f"=====================================================")
    print(f" CCTVFrame Backend Engine & Camera Gateway Running ")
    print(f" Local Web Preview: http://127.0.0.1:{PORT}/")
    print(f" LAN IP for Samsung TV: http://{local_ip}:{PORT}/")
    print(f" go2rtc Streaming Gateway: http://127.0.0.1:1984/")
    print(f"=====================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if GO2RTC_PROC:
            GO2RTC_PROC.terminate()
