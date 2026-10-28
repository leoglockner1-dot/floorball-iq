# Local preview that behaves like GitHub Pages: /x serves x.html when it exists,
# and the site is reachable under /floorball-iq/ (its path on GitHub Pages).
# Run: python3 tools/serve.py [port]
import http.server, os, sys

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREFIX = '/floorball-iq'

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = path.split('?', 1)[0].split('#', 1)[0]
        if not clean.startswith(PREFIX):
            return os.path.join(SITE, '__missing__')
        rel = clean[len(PREFIX):].lstrip('/')
        full = os.path.join(SITE, rel)
        if not os.path.exists(full) and os.path.exists(full + '.html'):
            full += '.html'
        if not os.path.exists(full):
            full = os.path.join(SITE, '404.html')  # like GitHub Pages
        return full

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
