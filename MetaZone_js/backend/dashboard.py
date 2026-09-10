"""
dashboard.py (backend) — full rebuild matching every panel in the
original ui/dashboard.py: Today's Statistics, Lifetime, AI Usage,
Recent Activity, Productivity Insights, System Status, 7-day chart.
Same field names, same computations, ported from
DashboardPage._refresh_* methods — just reading real Session state
instead of a Tk `app` object.

Still deliberately excludes est_api_cost/est_api_cost_saved from what
reaches the frontend, per the free-providers-only product constraint
-- unchanged from the previous version of this file.
"""
from core import stats_db
from core.config import load_prefs, save_prefs
from engine.ai_providers import get_active_keys


def _resource_usage():
    """CPU/RAM for the System Status card (v0.8.7). Re-attempted after
    being removed in the CTk version (v0.7.2) when psutil reliably
    returned N/A there -- never confirmed whether that was a genuine
    psutil issue or a PyInstaller-bundling one (psutil ships a compiled
    backend per-platform that --add-data-based bundling can miss; see
    app.py's import sqlite3/PIL.Image comment for the same class of
    issue with other compiled deps). requirements.txt already lists
    psutil and this pywebview build imports it directly at the top of
    app.py's module graph (not via the backend/ --add-data path that
    caused the CTk-era doubt), which is the more reliable bundling
    route -- but this still can't be verified as actually correct
    inside a real Windows PyInstaller EXE from this sandbox, only that
    it works correctly un-frozen. Fails soft to None per-field (never
    crashes the dashboard) so the frontend can show "N/A" instead of a
    wrong number if it doesn't come through on a given machine.
    GPU is deliberately NOT attempted: there's no single library that
    reads usage across NVIDIA/AMD/Intel without extra heavyweight,
    vendor-specific dependencies (e.g. pynvml, which only covers
    NVIDIA) -- adding one just for this would be a disproportionate
    amount of new surface area for one dashboard field, so it's left
    out rather than shipped half-working for a subset of users' GPUs.
    """
    try:
        import psutil
        cpu = psutil.cpu_percent(interval=0.1)
        ram = psutil.virtual_memory().percent
        return {"cpu_percent": round(cpu, 1), "ram_percent": round(ram, 1)}
    except Exception:
        return {"cpu_percent": None, "ram_percent": None}


def get_dashboard_data(meta_session=None):
    prefs = load_prefs()
    today = stats_db.today_summary()
    lt = stats_db.lifetime_summary()
    days, series = stats_db.last_n_days_series(7)
    recent = stats_db.recent_activity(4)

    try:
        active_keys = len(get_active_keys(prefs))
    except Exception:
        active_keys = 0
    limit_per_key = int(prefs.get("ai_daily_limit_per_key", 250))
    used_today = today.get("api_requests", 0)
    total_capacity = active_keys * limit_per_key
    remaining = max(total_capacity - used_today, 0)

    running = bool(meta_session and meta_session.running)
    last_provider = (meta_session.last_provider if meta_session else None) or "—"
    last_model = (meta_session.last_model if meta_session else None) or "—"

    week_total = sum(series["files_processed"])
    speed = None
    if lt["total_processing_seconds"] > 0 and lt["total_files_processed"] > 0:
        speed = lt["total_files_processed"] / (lt["total_processing_seconds"] / 60)

    return {
        "today": today,
        "lifetime": {k: v for k, v in lt.items() if not k.startswith("est_api_cost")},
        "chart": {"days": days, "series": series},
        "recent_activity": [
            {"ts": ts, "kind": kind, "status": status, "count": count, "detail": detail}
            for (ts, kind, status, count, detail) in recent
        ],
        "ai_usage": {
            "provider": last_provider,
            "model": last_model,
            "requests": lt["total_api_requests"],
            "requests_saved": lt["total_api_requests_saved"],
            "active_keys": active_keys,
            "daily_limit_per_key": limit_per_key,
            "used_today": used_today,
            "total_capacity": total_capacity,
            "remaining": remaining,
        },
        "insights": {
            "images_this_week": week_total,
            "requests_saved": lt["total_api_requests_saved"],
            "avg_score": today.get("avg_score"),
            "speed_img_per_min": round(speed, 1) if speed else None,
        },
        "system": {
            "worker": "Active" if running else "Idle",
            "background_tasks": 1 if running else 0,
            "queue": "Processing" if running else "Empty",
            **_resource_usage(),
        },
    }


def set_daily_limit(value):
    try:
        val = max(1, int(value))
    except Exception:
        val = 250
    prefs = load_prefs()
    prefs["ai_daily_limit_per_key"] = val
    save_prefs(prefs)
    return {"ok": True, "value": val}
