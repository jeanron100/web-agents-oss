"""Create checksummed desktop ZIPs from a verified, public source tree."""
import hashlib
import pathlib
import re
import sys
import zipfile

root = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve()
version = (root / 'release/version').read_text().strip()
if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', version):
    raise ValueError('Invalid release/version')
if not (root / 'SOURCE-MANIFEST.json').is_file():
    raise ValueError('Desktop bundles require a manifested public tree')
# Only ship manifested public source, never a working tree's credentials or .git.
import json
files = [item['path'] for item in json.loads((root / 'SOURCE-MANIFEST.json').read_text())['files']]
files.append('SOURCE-MANIFEST.json')
out.mkdir(parents=True, exist_ok=True)
for system in ['macos', 'windows']:
    filename = f'web-agents-{version}-{system}.zip'
    target = out / filename
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for relative in sorted(files):
            source = (root / relative).resolve()
            if not source.is_relative_to(root) or (root / relative).is_symlink():
                raise ValueError('Invalid manifest path')
            data = source.read_bytes()
            info = zipfile.ZipInfo(f'web-agents-{version}/{relative}')
            info.create_system = 3
            executable = relative.endswith(('.sh', '.command'))
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    checksum = hashlib.sha256(target.read_bytes()).hexdigest()
    (out / (filename + '.sha256')).write_text(f'{checksum}  {filename}\n', encoding='ascii')
    print(filename)
