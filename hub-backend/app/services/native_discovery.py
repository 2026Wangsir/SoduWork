"""Ephemeral native-relay presence and scoped, non-authoritative wake-ups.

No credentials or work payloads are stored here. Redis is mandatory in cluster
mode; failure must not silently downgrade to process-local presence.
"""
import hashlib
import json
import time
from collections import OrderedDict

from .cluster_bus import bus

TTL_SECONDS = 30
TOPICS = frozenset({"remote-screen", "personal-relay"})
EXTENDED_TOPICS = frozenset({"automation-inbox", "cloud-execution-sync", "conversation-projects",
                             "models", "config", "team-messages", "quota"})


class PresenceUnavailable(RuntimeError):
    pass


class Presence:
    def __init__(self, cluster=bus, clock=time.monotonic, max_entries=10000):
        self.cluster = cluster
        self.clock = clock
        self.max_entries = max_entries
        self.entries = OrderedDict()

    def key(self, device, owner, auth_version):
        digest = hashlib.sha256(json.dumps([str(device), str(owner), int(auth_version or 1)]).encode()).hexdigest()
        return self.cluster.key("native-relay-presence", digest)

    def prune(self):
        now = self.clock()
        while self.entries:
            key, expires = next(iter(self.entries.items()))
            if expires > now and len(self.entries) <= self.max_entries:
                break
            self.entries.pop(key, None)

    def redis(self):
        if not self.cluster.healthy or self.cluster.redis is None:
            raise PresenceUnavailable("Native relay presence is unavailable")
        return self.cluster.redis

    async def touch(self, device, owner, auth_version=1):
        if not device or not owner:
            return False
        key = self.key(device, owner, auth_version)
        if self.cluster.enabled:
            try:
                await self.redis().set(key, "1", ex=TTL_SECONDS)
            except Exception as error:
                raise PresenceUnavailable("Native relay presence is unavailable") from error
        else:
            self.entries[key] = self.clock() + TTL_SECONDS
            self.entries.move_to_end(key)
            self.prune()
        return True

    async def available(self, device, owner, auth_version=1):
        key = self.key(device, owner, auth_version)
        if self.cluster.enabled:
            try:
                return bool(await self.redis().exists(key))
            except Exception as error:
                raise PresenceUnavailable("Native relay presence is unavailable") from error
        self.prune()
        return self.entries.get(key, 0) > self.clock()


presence = Presence()


def heartbeat_request(raw):
    """Validate before consuming a socket's presence rate-limit window."""
    if not isinstance(raw, str) or len(raw) > 512:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or value.get("t") != "native-discovery" or value.get("protocol") not in (1, 2):
        return None
    topics = value.get("topics")
    supported = TOPICS if value["protocol"] == 1 else EXTENDED_TOPICS
    if not isinstance(topics, list) or not topics or len(topics) > len(supported) or any(not isinstance(t, str) or t not in supported for t in topics):
        return None
    return {"protocol": value["protocol"], "topics": list(dict.fromkeys(topics))}


def heartbeat_topics(raw):
    request = heartbeat_request(raw)
    return request["topics"] if request else None


async def confirmed_topics(topics):
    """A new socket node alone cannot promise that old writing nodes emit hints."""
    supported = set(EXTENDED_TOPICS)
    if bus.enabled:
        if not bus.healthy:
            return []
        try:
            nodes = await bus.redis.zrangebyscore(bus.key("nodes"),
                time.time() - bus.settings.cluster_lease_seconds, "+inf")
            if not nodes:
                return []
            states = await bus.redis.mget([bus.key("state", node.decode() if isinstance(node, bytes) else str(node))
                                          for node in nodes])
            for state in states:
                if not state:
                    return []
                peer = bus.codec.decode(state)
                supported.intersection_update(peer.get("nativeDiscoveryTopics", []))
        except Exception:
            return []
    return [topic for topic in topics if topic in supported]


async def heartbeat(raw, device, owner, auth_version=1):
    """Accept only capability names on an already authenticated device socket."""
    topics = heartbeat_topics(raw)
    if not owner or topics is None:
        return False
    # Screen-only consumers must never advertise a native relay executor.
    if "personal-relay" in topics:
        await presence.touch(device, owner, auth_version)
    return True


async def wake(device, owner, topic):
    if topic not in TOPICS | EXTENDED_TOPICS:
        return
    from ..realtime import hub
    try:
        await hub.publish(device, {"type": "native-discovery", "topic": topic}, user_id=owner)
    except Exception:
        # The committed request is authoritative and bounded polling repairs
        # a lost push, including Redis/broker failures during publication.
        pass
