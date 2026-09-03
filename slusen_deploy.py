import re
import json
import glob
import os
import requests
requests.packages.urllib3.disable_warnings()

TOKEN = "slusen_1OYvu9XmZI5SrMil7T_Pw2BICHoHithnJdqLST7U8UE"
BASE = "https://slusen.ngu.no"
SLUG = "inreach"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

html = open("index.html", encoding="utf-8").read()
css = open("styles.css", encoding="utf-8").read()
js = open("app.js", encoding="utf-8").read()

# Pick the backup with the latest internal `exportedAt` timestamp (not filename/mtime).
backups = glob.glob(os.path.join("Backups", "*.json"))
if not backups:
    raise SystemExit("No backup .json found in Backups/")

candidates = []
for path in backups:
    try:
        data = json.loads(open(path, encoding="utf-8").read())
    except Exception as e:
        print(f"  (skipping unreadable {path}: {e})")
        continue
    # Sort key: internal exportedAt when present, else fall back to file mtime.
    exported = data.get("exportedAt") or ""
    key = (1, exported) if exported else (0, str(os.path.getmtime(path)))
    candidates.append((key, path, data))

if not candidates:
    raise SystemExit("No valid backup .json could be parsed in Backups/")

_, newest, backup = max(candidates, key=lambda c: c[0])
print(f"Using backup: {newest}")
print(f"  devices: {len(backup.get('devices', []))} | logs: {len(backup.get('logs', []))}"
      f" | exportedAt: {backup.get('exportedAt')}")

# Slusen sanitizes inline <script>/<style> in the html field, so we send CSS and JS
# through the dedicated `css`/`js` fields (Slusen injects them as tags itself).
# The seed is prepended to the JS so window.__INREACH_SEED__ exists before app.js runs.
seed_json = json.dumps(backup, ensure_ascii=False)
js = f"window.__INREACH_SEED__ = {seed_json};\n{js}"

# Remove the local-only external references from the html (served via css/js fields now).
html = re.sub(r'\s*<link\s+rel="stylesheet"\s+href="styles\.css"\s*/?>', "", html)
html = re.sub(r'\s*<script\s+src="app\.js"\s*></script>', "", html)

r = requests.put(
    f"{BASE}/api/v2/pages/deploy/{SLUG}",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={"html": html, "css": css, "js": js, "title": "InReach Check-In"},
    verify=False,
)
r.raise_for_status()
print("Deploy result:", r.json())
print("HTML bytes:", len(html), "| CSS bytes:", len(css), "| JS bytes:", len(js))

# Verify
r = requests.get(f"{BASE}/api/v2/pages/deploy/{SLUG}", headers=HEADERS, verify=False)
p = r.json()
js_stored = p.get("js") or ""
print("Verify — title:", p.get("title"),
      "| stored CSS:", bool(p.get("css")),
      "| stored JS:", bool(js_stored),
      "| seed in JS:", "__INREACH_SEED__" in js_stored)
print("Live URL:", f"{BASE}/web/{SLUG}")
