#!/usr/bin/env python3
"""Mirror the USER-OWNED, already public, static APEX RTL Fixer build from Replit.
Render static deployment: build=python3 rtl-original/mirror.py, publish=rtl-original/dist.
Fail closed if Replit still serves its original construction placeholder.
"""
from __future__ import annotations
from collections import deque
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote
from urllib.request import Request, urlopen
import json, re, os, time

HOST = "recursive-honeydew-site.replit.app"
BASE = "https://" + HOST + "/"
OUT = Path(__file__).parent / "dist"
OUT.mkdir(parents=True, exist_ok=True)
MAX_FILES = 280
MAX_FILE_SIZE = 12_000_000

def pull(path):
    req = Request(urljoin(BASE,path),headers={
      "User-Agent":"Mozilla/5.0 (compatible; APEX-Static-Mirror/1.0)",
      "Accept":"*/*",
      "Cache-Control":"no-cache"
    })
    with urlopen(req,timeout=35) as r:
        mime=r.headers.get('Content-Type','').lower()
        data=r.read(MAX_FILE_SIZE+1)
        if len(data)>MAX_FILE_SIZE: raise RuntimeError(f'Overlarge asset: {path}')
        if r.status != 200: raise RuntimeError(f'HTTP {r.status} for {path}')
        return data,mime

def local_path(u, base='/'):
    if u.startswith(('data:','blob:','mailto:','#','javascript:')):return None
    full = urlsplit(urljoin(urljoin(BASE,base.lstrip('/')),u))
    if full.hostname!=HOST:return None
    p=unquote(full.path).lstrip('/')
    if not p:p='index.html'
    if any(seg in ('.','..') for seg in p.split('/')):return None
    return p

class Extract(HTMLParser):
    def __init__(self):super().__init__();self.paths=set()
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag in ('script','img','source','video','audio','iframe'):
            if a.get('src'):self.paths.add(a['src'])
        elif tag=='link':
            if a.get('href'):self.paths.add(a['href'])
        if a.get('srcset'):
            for s in a['srcset'].split(','):
                self.paths.add(s.strip().split(' ')[0])

def discover_refs(body,path,mime):
    links=set()
    if path.endswith('.html') or 'text/html' in mime:
        parser=Extract();parser.feed(body.decode('utf-8','replace'));links|=parser.paths
    if path.endswith('.css') or 'text/css' in mime:
        txt=body.decode('utf-8','replace')
        links|={x.strip(' "\'') for x in re.findall(r'url\(\s*([^)]*?)\s*\)',txt)}
        links|=set(re.findall(r'@import\s+["\']([^"\']+)',txt))
    if path.endswith('.webmanifest') or path.endswith('.json') and 'manifest' in path:
        try:
            obj=json.loads(body)
            for item in obj.get('icons',[]):links.add(item.get('src',''))
            for item in obj.get('screenshots',[]):links.add(item.get('src',''))
            for item in obj.get('shortcuts',[]):
                for icon in item.get('icons',[]):links.add(icon.get('src',''))
        except Exception:pass
    if path.endswith('.js') or 'javascript' in mime:
        txt=body.decode('utf-8','replace')
        # Vite emits hashed asset filenames inside compiled JS when resolving
        # lazy chunks, icons, fonts or images. Crawl those as well.
        links|={'/'+p for p in re.findall(r'(?:^|[^a-zA-Z0-9_])/?(assets/[a-zA-Z0-9_./%+@-]+\.(?:js|css|png|jpg|jpeg|svg|webp|avif|gif|woff2?|ttf|ico))',txt)}
        links|={'/'+p for p in re.findall(r'["\'](/(?:[a-zA-Z0-9_./%-]+\.(?:png|svg|webp|avif|woff2?|ico|webmanifest)))["\']',txt)}
    return {local_path(p,'/'+path) for p in links if p}

data,mime=pull('index.html')
text=data.decode('utf-8','replace')
if 'Replit Agent is building' in text:raise SystemExit('ERROR: Replit source still serves a placeholder. Refusing deployment.')
parser=Extract();parser.feed(text)
required={local_path(a) for a in parser.paths if a.endswith(('.js','.css')) and local_path(a)}
if not required: raise SystemExit('ERROR: no JS/CSS bundle detected; refusing to mirror placeholder.')
(OUT/'index.html').write_bytes(data)
queue=deque([(p, p in required) for p in discover_refs(data,'index.html',mime) if p and p!='index.html'])
queue.extend((name,False) for name in ['manifest.webmanifest','favicon.ico','icon.svg','apple-touch-icon.png','robots.txt','sw.js','service-worker.js'])
seen={'index.html'}
copied=0
while queue:
    path,mandatory=queue.popleft()
    if not path or path in seen:continue
    seen.add(path)
    if len(seen)>MAX_FILES:raise SystemExit('Asset limit exceeded')
    try:body,mime=pull(path)
    except Exception as e:
        if mandatory:raise SystemExit(f'REQUIRED ASSET MISSING: {path}: {e}')
        print(f'Skipping optional {path}: {e}')
        continue
    if 'text/html' in mime and not path.endswith('.html'):
        if mandatory:raise SystemExit(f'Unexpected HTML for required asset {path}')
        print(f'Skipping SPA fallback for missing optional {path}')
        continue
    out=OUT/path;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(body);copied+=1
    for found in discover_refs(body,path,mime):
        if found and found not in seen:queue.append((found,False))
    print('Copied',path,len(body))
# Render SPA fallback for client routing.
(OUT/'_redirects').write_text('/* /index.html 200\n')
print(f'READY: mirrored original Replit production interface, {copied} assets, from {HOST}')
