#!/usr/bin/env python3
"""Restore the version immediately before the Zhiexa-inspired upgrade."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'backups' / 'before-zhiexa-upgrade-20260918-235128'
FILES = [
    'index.html', 'app.js', 'app.css', 'legal-workspace.js',
    'legal-workspace.css', 'legal-skills.js', 'legal-skills.css',
    'bootstrap.js', 'Kimi-Work-Legal-交互演示.html', '演示说明.md',
    'scripts/build_demo.py', 'tests/state-regression.cjs',
]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Back up current files, then restore. Default only inspects.')
    args = parser.parse_args()
    payload = {name: (SOURCE / name).read_bytes() for name in FILES}
    if not args.apply:
        print(f'Backup found: {SOURCE}')
        for name, data in payload.items():
            print(f'{hashlib.sha256(data).hexdigest()[:12]}  {name} ({len(data):,} bytes)')
        print('No files changed. Add --apply to restore after creating a fresh backup.')
        return

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    archive_path = ROOT / 'backups' / f'pre-restore-upgrade-{stamp}.zip'
    current = [p for p in ROOT.iterdir() if p.is_file() and p.suffix in {'.html', '.css', '.js', '.md'}]
    current += [p for folder in ('scripts', 'tests') for p in (ROOT / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    manifest = {}
    with zipfile.ZipFile(archive_path, 'x', zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(current):
            name = file.relative_to(ROOT).as_posix()
            data = file.read_bytes()
            archive.writestr(name, data)
            manifest[name] = hashlib.sha256(data).hexdigest()
        archive.writestr('RESTORE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Current-version backup verification failed; restoration aborted.')
        for name, digest in manifest.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != digest:
                raise RuntimeError(f'Backup checksum mismatch: {name}')
    for name, data in payload.items():
        target = ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(f'Restored the pre-upgrade version. Current files backed up to: {archive_path}')
    print('Additional modules, research, other files and browser data were retained. Reload the page.')

if __name__ == '__main__':
    main()
