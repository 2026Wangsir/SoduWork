"""Pure model-reference classification shared by Hub and database-free Runners."""
from __future__ import annotations

def is_local_model_reference(value) -> bool:
    """Identify device-owned references that must not cross the Hub boundary."""
    model = str(value or "").strip()
    if model.startswith("local:"):
        return True
    if not model.startswith("image::"):
        return False
    provider, separator, name = model[len("image::"):].partition("::")
    return bool(separator and provider.strip() and name.strip().startswith("local:"))
