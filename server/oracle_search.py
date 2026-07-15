import json, time, urllib.request, urllib.parse

# ── Hermes Oracle ─────────────────────────────────────────────────────────────

def oracle_scan(conn, tenant_id: int, keywords: list[str] | None = None) -> dict:
    """Scan news/trends and generate content ideas."""
    kw = keywords or ["AI", "technology", "business"]
    headlines = []
    # Simulate RSS/trends via simple web requests
    sources = [
        ("Hacker News", f"https://hn.algolia.com/api/v1/search?query={urllib.parse.quote(kw[0])}&hitsPerPage=5"),
        ("TechCrunch", f"https://newsapi.org/v2/everything?q={urllib.parse.quote(kw[0])}&pageSize=5"),
    ]
    for src_name, url in sources:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AGENT-OS/1.0"})
            resp = urllib.request.urlopen(req, timeout=10)
            data = json.loads(resp.read())
            items = data.get("hits", data.get("articles", []))
            for item in items[:5]:
                title = item.get("title") or item.get("story_title") or ""
                if title:
                    headlines.append({
                        "title": title,
                        "url": item.get("url") or item.get("story_url") or "",
                        "source": src_name,
                        "summary": (item.get("story_text") or item.get("description") or "")[:200],
                    })
        except Exception:
            pass

    # Generate content ideas using AI if available
    ideas = []
    for h in headlines[:3]:
        ideas.append({
            "headline": h["title"],
            "angle": f"Create content based on this trend from {h['source']}",
            "suggested_title": f"How {h['title'][:60]} Is Changing Everything",
        })

    scan = {
        "keywords": kw,
        "headlines": headlines,
        "ideas": ideas,
        "created_at": int(time.time()),
    }
    # Store
    import server.db as db
    db.insert(conn, "oracle_scans", {
        "tenant_id": tenant_id,
        "keywords": json.dumps(kw),
        "results_json": json.dumps(headlines),
        "ideas_json": json.dumps(ideas),
        "created_at": int(time.time()),
    })
    return scan


def oracle_history(conn, tenant_id: int) -> list[dict]:
    """Return past scans."""
    import server.db as db
    rows = db.rows(conn, "SELECT * FROM oracle_scans WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20", (tenant_id,))
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "keywords": json.loads(r["keywords"]) if isinstance(r["keywords"], str) else r["keywords"],
            "headline_count": len(json.loads(r["results_json"])) if isinstance(r["results_json"], str) else 0,
            "created_at": r["created_at"],
        })
    return result


# ── Fire Coral Web Search ────────────────────────────────────────────────────

def _ddg_target(href: str) -> str | None:
    """Resolve a DuckDuckGo lite anchor to a real external http(s) URL.

    Result links are wrapped and protocol-relative, e.g.
    //duckduckgo.com/l/?uddg=<url-encoded-target>&rut=… — decode those, accept
    the occasional direct link, and drop DuckDuckGo's own nav/util links."""
    if not href:
        return None
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href and "uddg=" in href:
        try:
            qs = urllib.parse.urlparse(href).query
            target = urllib.parse.parse_qs(qs).get("uddg", [None])[0]
            return target if target and target.startswith("http") else None
        except Exception:
            return None
    if href.startswith("http") and "duckduckgo.com" not in href:
        return href
    return None


def web_search(query: str, top_k: int = 5) -> list[dict]:
    """Search the web using DuckDuckGo's lite endpoint (no API key needed)."""
    import html as _html
    import re
    query = (query or "").strip()
    if not query:
        return []
    results: list[dict] = []
    try:
        url = f"https://lite.duckduckgo.com/lite/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (AGENT-OS/1.0)"})
        resp = urllib.request.urlopen(req, timeout=15)
        page = resp.read().decode("utf-8", errors="replace")
        seen = set()
        for href, text in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.DOTALL):
            real = _ddg_target(href)
            title = _html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
            if not real or not title or real in seen:
                continue
            seen.add(real)
            results.append({
                "title": title[:120],
                "url": real,
                "snippet": "",
                "source": "web",
            })
            if len(results) >= top_k:
                break
    except Exception:
        pass
    return results


def save_search(conn, tenant_id: int, query: str, results: list[dict], agent_id: int | None = None):
    """Save a search query and its results."""
    import server.db as db
    db.insert(conn, "search_history", {
        "tenant_id": tenant_id,
        "agent_id": agent_id,
        "query": query,
        "results_json": json.dumps(results),
        "created_at": int(time.time()),
    })

    # If an agent made the search, save as memory
    if agent_id:
        for r in results[:3]:
            db.insert(conn, "agent_memory", {
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "memory_type": "personal",
                "topic": "Research",
                "fact": f"Searched for '{query}' — found: {r['title']}",
                "confidence": 0.8,
                "source": "web_search",
                "vault_path": None,
                "created_at": int(time.time()),
            })
