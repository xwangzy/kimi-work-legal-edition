#!/usr/bin/env python3
"""Inspect or restore the complete backup made before the September 21 demo changes."""
from pathlib import Path
import argparse, datetime, hashlib, json, zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'backups' / 'before-full-demo-20260921-231911'
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true',help='Back up the current version, then restore the verified source files.')
    args=parser.parse_args()
    manifest=json.loads((SOURCE/'BACKUP-MANIFEST.json').read_text())
    payload={}
    for name,digest in manifest.items():
        if Path(name).is_absolute() or '..' in Path(name).parts: raise ValueError('Unsafe backup path')
        data=(SOURCE/name).read_bytes()
        if hashlib.sha256(data).hexdigest()!=digest: raise ValueError('Backup checksum mismatch: '+name)
        payload[name]=data
    print(f'Verified {len(payload)} files: {SOURCE}')
    if not args.apply:
        print('No files changed. Run with --apply to restore; a fresh current-version archive is created first.')
        return
    archive_path=ROOT/'backups'/('before-restore-full-demo-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.zip')
    current=[p for p in ROOT.rglob('*') if p.is_file() and not any(x in {'backups','.git','node_modules','__pycache__'} for x in p.relative_to(ROOT).parts)]
    with zipfile.ZipFile(archive_path,'x',zipfile.ZIP_DEFLATED) as z:
        for p in current:z.write(p,p.relative_to(ROOT))
    with zipfile.ZipFile(archive_path) as z:
        if z.testzip():raise ValueError('New archive verification failed; not restoring')
    for name,data in payload.items():
        target=ROOT/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    print(f'Restored. Current version archived at: {archive_path}')
    print('Additional files and browser data retained. Reload the page; old index does not load added modules.')
if __name__=='__main__':main()
