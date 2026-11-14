"""Per-attempt proxy discovery and credential-free runtime download diagnostics."""
from __future__ import annotations

from http import HTTPStatus
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


def _proxies(*, include_macos_system: bool = False) -> dict[str, str]:
    system_reader = {
        "win32": "getproxies_registry",
        "darwin": "getproxies_macosx_sysconf",
    }.get(sys.platform)
    # Native npm consumers have their own bypass semantics. Only urllib
    # downloads opt into the macOS merge paired with the handler below.
    if sys.platform == "darwin" and not include_macos_system:
        return urllib.request.getproxies()
    if not system_reader:
        return urllib.request.getproxies()
    # A NO_PROXY-only environment must not hide the operating system's proxies.
    # Platform discovery helpers may be absent when tests emulate another OS.
    reader = getattr(urllib.request, system_reader, None)
    proxies = dict(reader() or {}) if reader else {}
    environment = urllib.request.getproxies_environment()
    # Presence matters: an explicitly empty scheme disables its system proxy.
    # The stdlib resolves lowercase precedence and CGI HTTP_PROXY handling.
    for key in os.environ:
        if key.lower().endswith("_proxy"):
            proxies.pop(key[:-6].lower(), None)
    proxies.update(environment)
    return proxies


def _origin(url: str) -> tuple[str, str, int] | None:
    try:
        parsed = urllib.parse.urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not parsed.hostname:
            return None
        port = parsed.port if parsed.port is not None else (443 if scheme == "https" else 80)
        return scheme, parsed.hostname.lower(), port
    except ValueError:
        return None


class _DownloadProxyHandler(urllib.request.ProxyHandler):
    def __init__(self, proxies: dict[str, str], hub: str):
        self.hub_origin = _origin(hub)
        super().__init__(proxies)

    def proxy_open(self, request, proxy, scheme):
        # Hub control traffic already uses a direct connection. Match its exact
        # origin on every request, including redirects; another origin still
        # uses the selected proxy and the stdlib's existing bypass rules.
        if self.hub_origin and _origin(request.full_url) == self.hub_origin:
            return None
        if sys.platform == "darwin" and not any(
                key.lower() == scheme + "_proxy" for key in os.environ):
            # Keep the system proxy's own exclusions even when NO_PROXY or a
            # different scheme's environment override masks stdlib discovery.
            bypass = getattr(urllib.request, "proxy_bypass_macosx_sysconf", None)
            if bypass and bypass(request.host):
                return None
        return super().proxy_open(request, proxy, scheme)


class _DownloadRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        redirected = super().redirect_request(request, response, code, message, headers, new_url)
        if redirected is not None:
            # urllib stores proxy credentials as ordinary request headers.
            # The next hop may be direct; its proxy handler can add its own
            # credentials if required after selecting that target's route.
            redirected.remove_header("Proxy-authorization")
        return redirected


class _DownloadRouteHandler(urllib.request.BaseHandler):
    # Observe the request after urllib selects its proxy and before socket I/O.
    # Leave bypass rules, redirects and CONNECT handling to the standard library.
    handler_order = 200

    def __init__(self, routes: list[dict]):
        self.routes = routes

    def http_open(self, request):
        origin = _origin(request.full_url)
        if origin and len(self.routes) < 12:
            scheme, host, port = origin
            host = "[" + host + "]" if ":" in host else host
            self.routes.append({
                "origin": "%s://%s:%d" % (scheme, host, port),
                "route": "proxy" if request.has_proxy() or getattr(request, "_tunnel_host", None) else "direct",
            })
        return None

    https_open = http_open


def open_download(request: urllib.request.Request, *, timeout: int):
    # A resident Runner must see proxy changes between installation attempts.
    # Keep default TLS verification and stdlib NO_PROXY bypass handling.
    routes: list[dict] = []
    opener = urllib.request.build_opener(
        _DownloadProxyHandler(_proxies(include_macos_system=True), str(os.environ.get("SODUWORK_HUB_HTTP_BASE") or "")),
        _DownloadRouteHandler(routes),
        _DownloadRedirectHandler())
    try:
        response = opener.open(request, timeout=timeout)
    except Exception as exc:
        exc._soduwork_download_routes = routes
        raise
    response._soduwork_download_routes = routes
    return response


def source_label(url: str) -> str:
    """Show the source location without userinfo, query tokens or fragments."""
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        if ":" in host:
            host = "[" + host + "]"
        if parsed.port is not None:
            host += ":" + str(parsed.port)
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except ValueError:
        return "自定义下载源"


_SSL_REASONS = frozenset({
    "CERTIFICATE_VERIFY_FAILED", "UNEXPECTED_EOF_WHILE_READING",
    "WRONG_VERSION_NUMBER", "NO_APPLICATION_PROTOCOL", "UNSUPPORTED_PROTOCOL",
    "SSLV3_ALERT_HANDSHAKE_FAILURE", "TLSV1_ALERT_PROTOCOL_VERSION",
    "TLSV1_ALERT_INTERNAL_ERROR", "TLSV1_ALERT_UNKNOWN_CA",
})
_INTEGRITY_ERRORS = frozenset({
    "下载文件超过安全大小限制", "下载内容超过安全大小限制",
    "安装包 SHA-256 校验失败", "The vendor download is larger than the safety limit",
})


def error_details(error: Exception) -> dict:
    """Return only bounded, structured fields; never echo remote exception text."""
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(error, urllib.error.HTTPError):
        category = "http"
    elif isinstance(reason, ssl.SSLCertVerificationError):
        category = "tls_certificate"
    elif isinstance(reason, ssl.SSLEOFError):
        category = "tls_eof"
    elif isinstance(reason, ssl.SSLError):
        category = "tls_protocol"
    elif isinstance(reason, socket.gaierror):
        category = "dns"
    elif isinstance(reason, TimeoutError) or getattr(reason, "winerror", None) == 10060:
        category = "timeout"
    elif isinstance(reason, OSError):
        category = "io"
    elif isinstance(error, ValueError):
        category = "format"
    elif isinstance(error, RuntimeError) and str(error) in _INTEGRITY_ERRORS:
        category = "integrity"
    else:
        category = "unknown"
    result = {"category": category}
    for field in ("errno", "winerror", "verify_code"):
        value = getattr(reason, field, None)
        if type(value) is int and abs(value) < 2 ** 31:
            result[field] = value
    if isinstance(error, urllib.error.HTTPError) and type(error.code) is int and 100 <= error.code <= 599:
        result["http_status"] = error.code
    ssl_reason = getattr(reason, "reason", None)
    if isinstance(ssl_reason, str) and ssl_reason in _SSL_REASONS:
        result["ssl_reason"] = ssl_reason
    return result


def error_label(error: Exception) -> str:
    """Use structured error fields; server/proxy text may contain credentials."""
    details = error_details(error)
    category = details["category"]
    if isinstance(error, urllib.error.HTTPError):
        messages = {404: "下载源没有此安装包", 410: "下载源已移除此安装包"}
        try:
            detail = messages.get(error.code) or HTTPStatus(error.code).phrase
        except ValueError:
            detail = "下载请求失败"
        return "HTTP %d（%s）" % (error.code, detail)
    if category == "tls_certificate":
        code = "（verify_code=%d）" % details["verify_code"] if "verify_code" in details else ""
        return "TLS 证书校验失败" + code
    if category == "tls_eof":
        return "TLS 连接被异常中断"
    if category == "tls_protocol":
        code = "（%s）" % details["ssl_reason"] if "ssl_reason" in details else ""
        return "TLS 握手或协议失败" + code
    if category == "dns":
        return "无法解析目标地址"
    winerror, errno = details.get("winerror"), details.get("errno")
    code = ("WinError %d" % winerror if isinstance(winerror, int)
            else "errno %d" % errno if isinstance(errno, int) else "")
    if category == "timeout":
        return "网络连接超时" + ("（%s）" % code if code else "")
    if category == "io":
        return "网络或文件访问失败" + ("（%s）" % code if code else "")
    if category == "integrity":
        return str(error)
    if category == "format":
        return "响应格式错误"
    return "网络请求失败"
