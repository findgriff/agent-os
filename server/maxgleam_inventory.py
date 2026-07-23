"""Max Gleam — stock and consumables tracking.

Two tables added to the maxgleam database (/var/lib/maxgleam/app.db):

  inventory_items   what is on the van and in the lock-up, with a reorder
                    threshold per line
  inventory_usage   what a job consumed, so usage can be costed per clean
                    and stock drawn down as work happens

Both are created with IF NOT EXISTS on first use rather than by editing
maxgleam's schema.sql, because that file belongs to another running
application and is not the source of truth for this box.

Stock is never allowed below zero: a usage entry that would overdraw is
clamped and the shortfall reported back, which is what actually happens on
a van — you cannot use what is not in the cage.
"""
from __future__ import annotations

import logging
import threading
import time

from server import partner
from server.maxgleam_ops import DEFAULT_TENANT_ID

log = logging.getLogger("agentos.maxgleam")

CATEGORIES = ["chemicals", "consumables", "equipment", "ppe", "spares", "other"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS inventory_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'consumables',
  quantity        INTEGER NOT NULL DEFAULT 0,
  unit            TEXT NOT NULL DEFAULT 'unit',
  min_quantity    INTEGER NOT NULL DEFAULT 0,
  supplier        TEXT,
  notes           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_ordered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON inventory_items(tenant_id, name);

CREATE TABLE IF NOT EXISTS inventory_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER,
  item_id       INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity_used INTEGER NOT NULL DEFAULT 1,
  used_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_item ON inventory_usage(item_id, used_at);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_job ON inventory_usage(job_id);
"""

# A window-cleaning round's standing consumables. Seeded ONCE, only into a
# table that was empty, so the dashboard opens with something real to adjust
# rather than a blank page. Delete any line that does not apply.
SEED_ITEMS = [
    ("Pure water (resin refill)", "consumables", 2, "sack", 1, None),
    ("Traditional washing-up liquid", "chemicals", 6, "bottle", 2, None),
    ("Glass polish / buffing cloth", "consumables", 12, "cloth", 4, None),
    ("Squeegee rubbers 14in", "spares", 20, "rubber", 8, None),
    ("Applicator sleeves", "spares", 6, "sleeve", 2, None),
    ("Water-fed pole brush head", "spares", 2, "head", 1, None),
    ("Nitrile gloves", "ppe", 4, "box", 2, None),
    ("Gutter vac bags", "consumables", 5, "bag", 2, None),
]

_ready = False
_ready_lock = threading.Lock()


def _conn():
    return partner._conn()


def _ensure() -> None:
    """Create the tables (and seed the starter catalogue) exactly once."""
    global _ready
    if _ready:
        return
    with _ready_lock:
        if _ready:
            return
        conn = _conn()
        conn.executescript(SCHEMA)
        conn.commit()
        empty = conn.execute("SELECT COUNT(*) FROM inventory_items").fetchone()[0] == 0
        if empty:
            conn.executemany(
                "INSERT INTO inventory_items "
                "  (tenant_id, name, category, quantity, unit, min_quantity, supplier) "
                "VALUES (?,?,?,?,?,?,?)",
                [(DEFAULT_TENANT_ID, *row) for row in SEED_ITEMS])
            conn.commit()
            log.info("maxgleam inventory: seeded %d starter item(s)", len(SEED_ITEMS))
        _ready = True


def _rows(sql: str, args=()) -> list[dict]:
    _ensure()
    return [dict(r) for r in _conn().execute(sql, args).fetchall()]


def _one(sql: str, args=()) -> dict | None:
    _ensure()
    r = _conn().execute(sql, args).fetchone()
    return dict(r) if r else None


# ------------------------------------------------------------------- usage --

USAGE_SELECT = """
  SELECT u.id, u.item_id, u.job_id, u.quantity_used, u.used_at,
         j.scheduled_date, p.address, s.name AS crew_name
    FROM inventory_usage u
    LEFT JOIN jobs j ON j.id = u.job_id
    LEFT JOIN properties p ON p.id = j.property_id
    LEFT JOIN subcontractors s ON s.id = j.subcontractor_id
"""

USAGE_PER_ITEM = 10


def _item_dto(item: dict, usage: list[dict]) -> dict:
    used_30d = sum(u["quantity_used"] for u in usage
                   if u["used_at"] >= int(time.time()) - 30 * 86400)
    return {
        **item,
        "low": item["quantity"] <= item["min_quantity"],
        "out": item["quantity"] <= 0,
        "used_30d": used_30d,
        "recent_usage": usage[:USAGE_PER_ITEM],
    }


def list_items(tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """GET /api/maxgleam/inventory — every line with its stock position."""
    items = _rows("SELECT * FROM inventory_items WHERE tenant_id = ? ORDER BY name",
                  (tenant_id,))
    ids = {i["id"] for i in items}
    usage = _rows(USAGE_SELECT + " ORDER BY u.used_at DESC, u.id DESC LIMIT 500")
    by_item: dict[int, list[dict]] = {}
    for u in usage:
        if u["item_id"] in ids:
            by_item.setdefault(u["item_id"], []).append(u)

    dtos = [_item_dto(i, by_item.get(i["id"], [])) for i in items]
    return 200, {
        "items": dtos,
        "categories": CATEGORIES,
        "summary": {
            "total": len(dtos),
            "low": sum(1 for d in dtos if d["low"]),
            "out": sum(1 for d in dtos if d["out"]),
        },
    }


def add_item(body: dict, tenant_id: int = DEFAULT_TENANT_ID) -> tuple[int, dict]:
    """POST /api/maxgleam/inventory/add."""
    name = (str(body.get("name") or "").strip())[:120]
    if not name:
        return 400, {"error": "give the item a name"}
    category = (body.get("category") or "consumables").strip().lower()
    if category not in CATEGORIES:
        category = "other"
    quantity = _int(body.get("quantity"), 0)
    min_quantity = _int(body.get("min_quantity"), 0)
    if quantity < 0 or min_quantity < 0:
        return 400, {"error": "quantities cannot be negative"}

    _ensure()
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO inventory_items "
        "  (tenant_id, name, category, quantity, unit, min_quantity, supplier, notes) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (tenant_id, name, category, quantity,
         (str(body.get("unit") or "unit").strip())[:24], min_quantity,
         (str(body.get("supplier") or "").strip())[:120] or None,
         (str(body.get("notes") or "").strip())[:500] or None))
    conn.commit()
    item = _one("SELECT * FROM inventory_items WHERE id = ?", (cur.lastrowid,))
    return 200, {"item": _item_dto(item, [])}


def use_item(body: dict) -> tuple[int, dict]:
    """POST /api/maxgleam/inventory/use — log consumption against a job."""
    item = _one("SELECT * FROM inventory_items WHERE id = ?", (_int(body.get("item_id"), 0),))
    if not item:
        return 404, {"error": "item not found"}
    wanted = _int(body.get("quantity_used") or body.get("quantity"), 1)
    if wanted <= 0:
        return 400, {"error": "quantity used must be at least 1"}

    job_id = _int(body.get("job_id"), 0) or None
    if job_id and not _one("SELECT id FROM jobs WHERE id = ?", (job_id,)):
        return 404, {"error": "job not found"}

    # Never take stock below zero — record what was actually available.
    taken = min(wanted, max(item["quantity"], 0))
    shortfall = wanted - taken
    if taken <= 0:
        return 409, {"error": f"{item['name']} is out of stock", "item": _item_dto(item, [])}

    conn = _conn()
    conn.execute("INSERT INTO inventory_usage (job_id, item_id, quantity_used, used_at) "
                 "VALUES (?,?,?,?)", (job_id, item["id"], taken, int(time.time())))
    conn.execute("UPDATE inventory_items SET quantity = quantity - ? WHERE id = ?",
                 (taken, item["id"]))
    conn.commit()

    fresh = _one("SELECT * FROM inventory_items WHERE id = ?", (item["id"],))
    usage = _rows(USAGE_SELECT + " WHERE u.item_id = ? ORDER BY u.used_at DESC LIMIT ?",
                  (item["id"], USAGE_PER_ITEM))
    return 200, {"item": _item_dto(fresh, usage), "used": taken,
                 "shortfall": shortfall or None}


def order_item(body: dict) -> tuple[int, dict]:
    """POST /api/maxgleam/inventory/order — log a reorder.

    Sending `quantity` books the delivery straight in; sending nothing just
    stamps the line as ordered so it stops nagging on the dashboard.
    """
    item = _one("SELECT * FROM inventory_items WHERE id = ?", (_int(body.get("item_id"), 0),))
    if not item:
        return 404, {"error": "item not found"}
    received = _int(body.get("quantity"), 0)
    if received < 0:
        return 400, {"error": "order quantity cannot be negative"}

    conn = _conn()
    conn.execute("UPDATE inventory_items SET last_ordered_at = ?, quantity = quantity + ? "
                 "WHERE id = ?", (int(time.time()), received, item["id"]))
    conn.commit()

    fresh = _one("SELECT * FROM inventory_items WHERE id = ?", (item["id"],))
    usage = _rows(USAGE_SELECT + " WHERE u.item_id = ? ORDER BY u.used_at DESC LIMIT ?",
                  (item["id"], USAGE_PER_ITEM))
    log.info("maxgleam inventory: %s reordered (+%d)", item["name"], received)
    return 200, {"item": _item_dto(fresh, usage), "received": received}


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
