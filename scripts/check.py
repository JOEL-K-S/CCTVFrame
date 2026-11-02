"""Check CCTVFrame manifest and bundled files."""
from pathlib import Path
import json
import xml.etree.ElementTree as XML

root = Path(__file__).resolve().parents[1]
app = root / 'app'
manifest = XML.parse(app / 'config.xml').getroot()
ns = {'w': 'http://www.w3.org/ns/widgets', 't': 'http://tizen.org/ns/widgets'}

identity = manifest.find('t:application', ns)
assert identity is not None, 'Missing application identity'
assert identity.get('package') == 'cctvframe1', 'Package mismatch'
assert identity.get('id') == 'cctvframe1.CCTVViewer', 'App ID mismatch'

pkg_json = json.loads((root / 'package.json').read_text(encoding='utf-8'))
assert manifest.get('version') == pkg_json['version'], 'Manifest/package versions differ'

for tag in ['content', 'icon']:
    node = manifest.find('w:' + tag, ns)
    assert node is not None and (app / node.get('src', '')).is_file(), f'Missing {tag} file'

for required_file in ['main.js', 'style.css', 'index.html']:
    assert (app / required_file).is_file(), f'Missing {required_file}'

print('CCTVFrame manifest and resources are valid.')

