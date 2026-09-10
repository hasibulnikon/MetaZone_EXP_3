"""
settings.py — full API Manager backend, matching ui/api_dialog.py's
APIManagerContent feature-for-feature: per-key cards (with raw key
available for reveal/copy -- this is a local single-user desktop app,
same trust boundary as the original CTk version, not a hosted
multi-tenant service), model selection per provider, Activate All/
Deactivate All, live key validation.
"""
from core.config import load_prefs, save_prefs
from core.constants import AI_PROVIDERS, VISIBLE_PROVIDERS
from engine.ai_providers import validate_key
import time


def get_provider_summary():
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {})
    models = prefs.get("ai_models", {})
    disabled = prefs.get("disabled_models", {})
    out = []
    for p in VISIBLE_PROVIDERS:
        cfg = AI_PROVIDERS.get(p, {})
        provider_keys = keys.get(p, [])
        all_models = cfg.get("models", [])  # [(label, id), ...]
        disabled_ids = set(disabled.get(p, []))
        # v0.9.5: model enable/disable (per-provider). "Disabled" only
        # ever means "hidden from the Model Selection dropdown" -- it
        # doesn't touch AI_PROVIDERS, doesn't remove the model from the
        # app, and doesn't stop an already-selected model from being
        # used for generation. current_model always falls back to a
        # still-enabled model if its stored choice got disabled (see
        # set_model_enabled), so it's never silently left pointing at
        # something the dropdown can't show as selected.
        enabled_models = [(label, mid) for (label, mid) in all_models if mid not in disabled_ids]
        current_model = models.get(p, cfg["models"][0][1] if cfg.get("models") else "")
        out.append({
            "provider": p,
            "key_url": cfg.get("key_url", ""),
            "key_hint": cfg.get("key_hint", ""),
            "models": enabled_models,          # what the dropdown should show
            "all_models": all_models,          # every model this provider supports (for the settings panel)
            "disabled_models": sorted(disabled_ids),
            "current_model": current_model,
            "active_count": sum(1 for k in provider_keys if k.get("active")),
            "keys": [
                {
                    "key": k.get("key", ""),  # raw -- see module docstring
                    "masked": _mask(k.get("key", "")),
                    "active": k.get("active", False),
                    # v0.9.4 (item 15): nickname + last-test result are
                    # real, persisted fields now (see set_key_nickname /
                    # record_key_test) -- not fabricated. A key that has
                    # never been tested simply has last_test: None, and
                    # the frontend shows that honestly as "Unknown"
                    # rather than inventing a status.
                    "nickname": k.get("nickname", ""),
                    "last_test": k.get("last_test"),
                }
                for k in provider_keys
            ],
        })
    return out


def set_model_enabled(provider, model_id, enabled):
    """v0.9.5: toggles a single model's visibility in the Model
    Selection dropdown for one provider. Refuses to disable the last
    remaining enabled model for a provider (a provider with zero
    selectable models would be a dead end in the UI with no recovery
    path except editing prefs.json by hand) -- returns an error
    instead. If the model being disabled is the provider's current
    selection, reassigns current_model to the first still-enabled
    model so the dropdown never ends up "selected" on a hidden option.
    """
    prefs = load_prefs()
    cfg = AI_PROVIDERS.get(provider, {})
    all_ids = [mid for (_, mid) in cfg.get("models", [])]
    if model_id not in all_ids:
        return {"ok": False, "error": "Unknown model"}

    disabled = prefs.setdefault("disabled_models", {})
    provider_disabled = set(disabled.get(provider, []))

    if not enabled:
        would_remain = [mid for mid in all_ids if mid not in provider_disabled and mid != model_id]
        if not would_remain:
            return {"ok": False, "error": "At least one model must stay enabled."}
        provider_disabled.add(model_id)
    else:
        provider_disabled.discard(model_id)

    disabled[provider] = sorted(provider_disabled)
    prefs["disabled_models"] = disabled

    new_current = None
    models_prefs = prefs.setdefault("ai_models", {})
    current = models_prefs.get(provider)
    if not enabled and current == model_id:
        remaining = [mid for mid in all_ids if mid not in provider_disabled]
        new_current = remaining[0] if remaining else None
        if new_current:
            models_prefs[provider] = new_current

    save_prefs(prefs)
    return {"ok": True, "disabled_models": sorted(provider_disabled), "new_current_model": new_current}


def _mask(key):
    # Matches the original exactly: "..." + last 10 chars.
    return "..." + key[-10:] if len(key) > 10 else key


def set_model(provider, model_id):
    prefs = load_prefs()
    prefs.setdefault("ai_models", {})[provider] = model_id
    save_prefs(prefs)
    return {"ok": True}


def add_key(provider, key):
    """Matches the original's _add_key exactly: saves immediately,
    joins as active WITHOUT touching any other key's active state (a
    fix already made in the original for a real prior bug -- adding a
    key used to silently deactivate the whole failover set)."""
    key = (key or "").strip()
    if not key:
        return {"ok": False, "error": "Empty key"}
    prefs = load_prefs()
    keys = prefs.setdefault("ai_keys", {}).setdefault(provider, [])
    if any(k.get("key") == key for k in keys):
        return {"ok": False, "error": "Already saved"}
    keys.append({"key": key, "active": True})
    save_prefs(prefs)
    return {"ok": True}


def set_key_active(provider, index, active):
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {}).get(provider, [])
    if index < 0 or index >= len(keys):
        return {"ok": False, "error": "Bad index"}
    keys[index]["active"] = active
    save_prefs(prefs)
    return {"ok": True}


def set_all_active(provider, active):
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {}).get(provider, [])
    for k in keys:
        k["active"] = active
    save_prefs(prefs)
    return {"ok": True}


def delete_key(provider, index):
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {}).get(provider, [])
    if index < 0 or index >= len(keys):
        return {"ok": False, "error": "Bad index"}
    keys.pop(index)
    save_prefs(prefs)
    return {"ok": True}


def set_key_nickname(provider, index, nickname):
    """v0.9.4 (item 15): a plain-text label per key ("Gemini Main",
    "Work Account", etc.) -- purely cosmetic, never sent anywhere,
    stored right alongside the key it labels."""
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {}).get(provider, [])
    if index < 0 or index >= len(keys):
        return {"ok": False, "error": "Bad index"}
    keys[index]["nickname"] = (nickname or "").strip()[:60]
    save_prefs(prefs)
    return {"ok": True}


def record_key_test(provider, key, ok, message):
    """v0.9.4 (item 15): persists a real validate_key() result onto the
    matching stored key (found by exact key value, not index -- a test
    can be in flight while the person reorders/deletes other keys, and
    matching by value is immune to that race the way an index wouldn't
    be) so "last tested" and a real status survive a reload instead of
    only living in a transient frontend variable. Distinguishes
    invalid-credentials from a network/other error using the same
    message text validate_key() already produces, rather than
    collapsing both into one generic "failed" -- see engine/
    ai_providers.validate_key's HTTPError handling for exactly which
    messages mean which.
    """
    status = "valid" if ok else ("invalid" if message.startswith("Invalid key") else "error")
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {}).get(provider, [])
    for k in keys:
        if k.get("key") == key:
            k["last_test"] = {"status": status, "message": message, "at": time.time()}
            break
    save_prefs(prefs)
    return {"ok": True, "status": status}


def activate_valid_keys(provider):
    """v0.9.4 (item 15): activates every key whose *last recorded test*
    was valid, deactivates the rest. Deliberately does not test
    untested keys itself (that's what Test All is for) -- only acts on
    real, already-known results, so this can't silently activate a key
    nobody has ever actually confirmed works."""
    prefs = load_prefs()
    keys = prefs.get("ai_keys", {}).get(provider, [])
    changed = 0
    for k in keys:
        want = bool(k.get("last_test") and k["last_test"].get("status") == "valid")
        if k.get("active", False) != want:
            changed += 1
        k["active"] = want
    save_prefs(prefs)
    return {"ok": True, "changed": changed}
