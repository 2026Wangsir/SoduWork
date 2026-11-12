"""Keep Runner diagnostics compatible with its UTF-8 desktop transport."""
import sys


def configure_output_streams():
    # Frozen Python may ignore PYTHONIOENCODING/PYTHONUTF8. Windows pipes then
    # use the ANSI code page and cannot print localized help or diagnostics.
    # Reconfigure in place: RPC writes still use the same underlying buffer.
    for stream, errors in ((sys.stdout, 'strict'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if callable(reconfigure):
            reconfigure(encoding='utf-8', errors=errors)
