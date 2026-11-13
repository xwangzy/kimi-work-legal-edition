#!/usr/bin/env python3
"""Build a self-contained, dependency-free HTML demo from the source modules."""
from pathlib import Path
import hashlib
import re

ROOT = Path(__file__).resolve().parent.parent
index = ROOT / 'index.html'
html = index.read_text(encoding='utf-8')

def version_asset(match):
    attr, name = match.group(1), match.group(2)
    digest = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()[:10]
    return f'{attr}="{name}?v={digest}"'

html = re.sub(r'(href|src)="([^"?]+\.(?:css|js))(?:\?[^\"]*)?"', version_asset, html)
index.write_text(html, encoding='utf-8')

def style(match):
    name = match.group(1).split('?')[0]
    css = (ROOT / name).read_text(encoding='utf-8').replace('</style', '<\\/style')
    return f'<style>\n/* {name} */\n{css}\n</style>'

def script(match):
    name = match.group(1).split('?')[0]
    js = (ROOT / name).read_text(encoding='utf-8').replace('</script', '<\\/script')
    return f'<script>\n// {name}\n{js}\n</script>'

html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', style, html)
# Inline scripts must execute after the app/overlay/toast elements exist.
scripts = re.findall(r'<script defer src="([^"]+)"></script>', html)
html = re.sub(r'\s*<script defer src="[^"]+"></script>', '', html)
inline = '\n'.join(script(re.match(r'(.*)', name)) for name in scripts)
html = html.replace('</body>', inline + '\n</body>')
output = ROOT / 'Kimi-Work-Legal-交互演示.html'
output.write_text(html, encoding='utf-8')
assert 'src="app.js' not in html and 'href="app.css' not in html
print(f'Built: {output.name} ({output.stat().st_size:,} bytes)')
