#!/bin/bash
cd "$(dirname "$0")"
mkdir -p dist
python3 - <<'PY'
s=open('src.html').read(); e=open('engine.js').read()
open('dist/index.html','w').write(s.replace('<!--ENGINE-->',e))
PY
cp manifest.webmanifest sw.js icon.svg README.md dist/ 2>/dev/null
echo built
