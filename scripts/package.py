"""Build and sign CCTVFrame with official Tizen SDK CLI."""
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CLI = Path('C:/tizen-studio/tools/ide/bin/tizen.bat')
PROFILE_NAME = 'homescreen'

dist = ROOT / 'dist'
dist.mkdir(exist_ok=True)
unsigned = dist / 'CCTVFrame-unsigned.wgt'

# Package app folder into zip
app_dir = ROOT / 'app'
with zipfile.ZipFile(unsigned, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in app_dir.rglob('*'):
        if f.is_file():
            z.write(f, f.relative_to(app_dir).as_posix())

signed_dir = dist / 'signed'
signed_dir.mkdir(exist_ok=True)

result = subprocess.run([str(CLI), 'package', '-t', 'wgt', '-s', PROFILE_NAME,
                         '-o', str(signed_dir), '--', str(unsigned)],
                        capture_output=True, text=True)
if result.returncode != 0:
    print(result.stdout)
    print(result.stderr)
    raise SystemExit('SDK signing failed')
else:
    print(result.stdout)
    print('Signed widget created successfully')

signed = signed_dir / unsigned.name
with zipfile.ZipFile(signed) as package:
    if not {'author-signature.xml', 'signature1.xml'}.issubset(package.namelist()):
        raise SystemExit('Package is missing its signing files.')

target = dist / 'CCTVFrame.wgt'
target.write_bytes(signed.read_bytes())
print('Signed widget created: ' + str(target))
