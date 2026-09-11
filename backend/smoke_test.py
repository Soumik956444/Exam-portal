"""Small manual smoke test helper.
Run the API first, then execute this script.
"""
import json
import sys
from urllib.request import Request, urlopen

PORT = sys.argv[1] if len(sys.argv) > 1 else "8000"
BASE = f"http://127.0.0.1:{PORT}/api"

def post(path, payload):
    req = Request(BASE + path, data=json.dumps(payload).encode(), headers={"Content-Type":"application/json"})
    with urlopen(req) as r:
        return json.loads(r.read())

print("Health:", urlopen(BASE + "/health").read().decode())
print("Login:", post("/auth/login", {"email":"student@example.com", "password":"ChangeMe123!"})["user"])
