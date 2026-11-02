"""Connect, inspect, install or launch CCTVFrame on Samsung TV."""
import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import subprocess
import time
import xml.etree.ElementTree as XML

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['info', 'install', 'launch'])
parser.add_argument('--host')
args = parser.parse_args()

config_file = ROOT / '.local/device.json'
config = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else {}
host = args.host or config.get('host') or '192.168.1.133'
ipaddress.ip_address(host)

sdb_candidates = [
    Path('C:/tizen-studio/tools/sdb.exe'),
    ROOT / '.local/tizen-sdk/tools/sdb',
    ROOT / '.local/tizen-sdk/tools/sdb.exe',
]
sdb = next((p for p in sdb_candidates if p.exists()), None)
if not sdb:
    import shutil
    which = shutil.which('sdb')
    if which:
        sdb = Path(which)
    else:
        raise SystemExit('Local SDB tool missing. Make sure Tizen Studio is installed.')

manifest = XML.parse(ROOT / 'app/config.xml').getroot()
app_id = manifest.find('{http://tizen.org/ns/widgets}application').get('id')


def run(*command, quiet=False):
    result = subprocess.run([str(sdb), *command], text=True, capture_output=True, timeout=45)
    output = result.stdout + result.stderr
    if not quiet:
        print(output, end='' if output.endswith('\n') else '\n', flush=True)
    if result.returncode:
        raise SystemExit('SDB command failed.')
    return output


serial = host + ':26101'
print(f"Connecting to {serial}...")
connected = run('connect', serial)
if 'connected to ' not in connected.lower() and 'already connected' not in connected.lower():
    raise SystemExit('TV connection was not confirmed.')

if args.action == 'info':
    run('-s', serial, 'capability')
elif args.action == 'launch':
    print(f"Launching {app_id}...")
    output = run('-s', serial, 'shell', '0', 'execute', app_id)
    if 'successfully launched' not in output:
        output = run('-s', serial, 'shell', f"0 wascmd 11 {app_id} 0")
        if 'failed' in output.lower():
            raise SystemExit('App launch was not confirmed. Check the TV.')
else:
    widget = ROOT / 'dist/CCTVFrame.wgt'
    if not widget.exists():
        raise SystemExit('Run npm run package first.')
    digest = hashlib.sha256(widget.read_bytes()).hexdigest()[:12]
    remote = '/home/owner/share/tmp/sdk_tools/CCTVFrame-' + digest + '-' + str(time.time_ns()) + '.wgt'
    print(f"Pushing {widget.name}...")
    pushed = run('-s', serial, 'push', str(widget), remote)
    if '1 file(s) pushed' not in pushed or 'failed' in pushed.lower():
        raise SystemExit('Widget transfer was not confirmed.')
    print("Installing app...")
    output = run('-s', serial, 'shell', '0', 'vd_appinstall', app_id, remote)
    if 'install completed' not in output or 'install failed' in output:
        output = run('-s', serial, 'shell', f"0 wascmd 7 {app_id} {remote}")
        if 'failed' in output.lower():
            raise SystemExit('TV installation failed or was not confirmed.')
    installed = run('-s', serial, 'shell', '0', 'applist', quiet=True)
    if app_id in installed:
        print(f"Installation verified: {app_id} present in applist.")
    print('CCTVFrame installation confirmed.')
