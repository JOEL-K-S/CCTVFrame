"""Install and launch CCTVFrame on the Samsung TV."""
import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SDB = Path('C:/tizen-studio/tools/sdb.exe')
HOST = '192.168.1.133'
SERIAL = HOST + ':26101'
APP_ID = 'cctvframe1.CCTVViewer'
WGT = ROOT / 'dist/CCTVFrame.wgt'

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['install', 'launch'])
args = parser.parse_args()

def run(*cmd):
    p = subprocess.run([str(SDB), *cmd], capture_output=True, text=True)
    out = p.stdout + p.stderr
    print(out)
    return p

print(f"Connecting to {SERIAL}...")
run('connect', SERIAL)

if args.action == 'install':
    remote_path = f"/home/owner/share/tmp/sdk_tools/{WGT.name}"
    print(f"Pushing {WGT.name}...")
    run('-s', SERIAL, 'push', str(WGT), remote_path)
    print("Installing app...")
    run('-s', SERIAL, 'shell', f"0 wascmd 7 {APP_ID} {remote_path}")
    print("Done!")

elif args.action == 'launch':
    print(f"Launching {APP_ID}...")
    run('-s', SERIAL, 'shell', f"0 wascmd 11 {APP_ID} 0")

