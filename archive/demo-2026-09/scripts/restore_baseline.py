#!/usr/bin/env python3
"""Restore only the original demo entrypoints; retain a fresh pre-restore backup."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / 'backups' / 'baseline-20260917-220222.zip'
FILES = ['index.html', 'app.css', 'app.js', 'Kimi-Work-Legal-交互演示.html', '演示说明.md']
parser = argparse.ArgumentParser(description='Restore the original demo after saving the current version.')
parser.add_argument('--apply', action='store_true', help='Apply restoration (default: inspect only).')
args = parser.parse_args()
with zipfile.ZipFile(BASELINE) as archive:
    assert archive.testzip() is None, 'Backup integrity check failed.'
    manifest = json.loads(archive.read('BACKUP-MANIFEST.json'))
    for name in FILES:
        assert hashlib.sha256(archive.read(name)).hexdigest() == manifest[name], name
    if not args.apply:
        print('Backup verified. Restore these files with --apply:')
        print('\n'.join(FILES))
    else:
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        snapshot = ROOT / 'backups' / f'pre-restore-{stamp}.zip'
        current_files = FILES + ['legal-workspace.js', 'legal-workspace.css', 'legal-skills.js', 'legal-skills.css', 'bootstrap.js']
        with zipfile.ZipFile(snapshot, 'w', zipfile.ZIP_DEFLATED) as current:
            for name in current_files:
                if (ROOT / name).is_file():
                    current.write(ROOT / name, name)
        for name in FILES:
            (ROOT / name).write_bytes(archive.read(name))
        print(f'Restored baseline; current version saved at {snapshot}')
        print('New supporting files are retained. Reload the browser to view the original demo.')
