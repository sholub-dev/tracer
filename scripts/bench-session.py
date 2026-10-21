#!/usr/bin/env python3
"""Run one chat turn against the local server and print its steps, analysis ledger and finding card.

Usage: scripts/bench-session.py "<question>" [session-id]
A session id continues that session; without one a new session starts.
"""
import json
import sys
import urllib.parse
import urllib.request
import uuid

BASE = "http://localhost:3579"


def post_turn(sid: str, text: str) -> None:
    body = {"id": sid, "message": {"id": str(uuid.uuid4()), "role": "user", "parts": [{"type": "text", "text": text}]}}
    req = urllib.request.Request(f"{BASE}/api/chat", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=3600) as res:
        for _ in res:
            pass


def messages(sid: str) -> list:
    q = urllib.parse.quote(json.dumps({"json": {"id": sid}}))
    with urllib.request.urlopen(f"{BASE}/api/trpc/sessions.get?input={q}") as res:
        return json.loads(json.load(res)["result"]["data"]["json"]["messagesJson"])


def main() -> None:
    text = sys.argv[1]
    sid = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
    post_turn(sid, text)
    msgs = messages(sid)
    last_user = max(i for i, m in enumerate(msgs) if m["role"] == "user" and not (m.get("metadata") or {}).get("steered"))
    print(f"SESSION {sid}\nQUESTION {text}\n")
    queries = 0
    for m in msgs[last_user + 1:]:
        for p in m["parts"]:
            t, i = p["type"], p.get("input") or {}
            if t == "text" and p["text"].strip():
                print("TEXT:", p["text"].strip()[:400].replace("\n", " "))
            elif t == "tool-begin_analysis":
                print("LEDGER:", json.dumps(i, indent=1, ensure_ascii=False))
                print("CHALLENGES:", json.dumps((p.get("output") or {}).get("challenges"), ensure_ascii=False))
            elif t == "tool-report_finding":
                print("CARD:", json.dumps(i, indent=1, ensure_ascii=False))
                if (p.get("output") or {}).get("recorded") is False:
                    print("CARD SENT BACK:", p["output"].get("problems", "").replace("\n", " "))
            elif t.startswith("tool-"):
                queries += 1
                print(f"STEP {queries}: {t[5:]} | {i.get('title', '')} | {(i.get('nrql') or i.get('query') or '')[:300]}")
                print("  ->", json.dumps(p.get("output"), ensure_ascii=False)[:600])


if __name__ == "__main__":
    main()
