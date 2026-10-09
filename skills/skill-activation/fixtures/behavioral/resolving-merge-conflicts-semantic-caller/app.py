from lib.store import fetch, insert


def record_order(order_id, total, status="open"):
    insert("orders", {"id": order_id, "total": total, "status": status})


def order_count():
    return len(fetch("orders"))
