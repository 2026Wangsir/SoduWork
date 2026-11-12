"""Real-time WebSocket delivery using short-lived device sessions. Prefer first-frame
authentication; accept legacy query credentials only while DEVICE_AUTH_COMPAT is enabled.
"""
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from ..db import SessionLocal
from ..config import get_settings
from ..realtime import hub
from ..services import device_auth
from ..services import native_discovery

router = APIRouter()
settings = get_settings()


@router.websocket("/api/v1/ws")
async def ws(websocket: WebSocket, device: str, secret: str | None = None,
             device_session: str | None = Query(default=None, alias="session")):
    accepted = False
    if secret is None and device_session is None:
        # Accept the connection, then authenticate the first frame; authentication failure closes with 4401.
        await websocket.accept()
        accepted = True
        resolved = await device_auth.creds_from_first_frame(websocket, device)
        if resolved is None:
            # A peer may disconnect while the first auth frame is pending.
            # Only a still-connected unauthenticated socket needs rejection.
            if websocket.client_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=4401)
            return
        secret, device_session = resolved
    # Reuse full REST device validation, including activation and disabled status, not only secret verification.
    async with SessionLocal() as session:
        try:
            c = await device_auth.client_from_transport(
                session, device, device_session=device_session or "",
                secret=secret or "", allow_legacy=settings.device_auth_compat,
            )
        except device_auth.DeviceAuthError:
            c = None
    if c is None:
        await websocket.close(code=4401)  # Unregistered device.
        return
    # First-frame authentication already accepted the socket; register it without a second ASGI accept.
    ok = await hub.connect(device, websocket, accept=not accepted, user_id=c.user_ref)
    if not ok:
        await websocket.close(code=4429)  # Connection limit exceeded.
        return
    try:
        # Register the connection before revalidating authorization to close the revocation race.
        # A concurrent disable is detected by the updated authorization version.
        # Later revocation can find and close the registered connection.
        async with SessionLocal() as session:
            try:
                await device_auth.client_from_transport(
                    session, device, device_session=device_session or "",
                    secret=secret or "", allow_legacy=settings.device_auth_compat,
                )
            except device_auth.DeviceAuthError:
                await websocket.close(code=4403)
                return
        await websocket.send_json({"type": "ready", "device": device})
        # Some legacy clients require manual installation because their updater or signing trust is obsolete.
        # Notify those devices on connection, at most once per device every 24 hours.
        try:
            from ..services import update_nudges
            async with SessionLocal() as session:
                latest = await update_nudges.latest_client_release(session)
            await update_nudges.nudge_stale_client(
                device, str(getattr(c, "app_version", "") or ""), latest)
        except Exception:  # noqa: BLE001  Upgrade-notification failures must not prevent connection.
            pass
        last_presence = {}
        while True:
            raw = await websocket.receive_text()
            discovery_request = native_discovery.heartbeat_request(raw)
            if discovery_request is None:
                continue
            # The socket's authenticated binding is the only source of device
            # and account identity. Client fields cannot select another target.
            now = time.monotonic()
            protocol = discovery_request["protocol"]
            if now - last_presence.get(protocol, -float("inf")) < 10:
                continue
            last_presence[protocol] = now
            try:
                accepted_presence = await native_discovery.heartbeat(raw, device, c.user_ref, c.auth_version)
            except native_discovery.PresenceUnavailable:
                accepted_presence = False
            if accepted_presence:
                confirmation = {"type": "native-discovery-ready", "protocol": protocol}
                if protocol == 2:
                    confirmation["topics"] = await native_discovery.confirmed_topics(discovery_request["topics"])
                await websocket.send_json(confirmation)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - a broken peer must still be unregistered
        pass
    finally:
        await hub.disconnect(device, websocket)
