#!/usr/bin/env python3
"""
    Host-side daemon for the PassFF Snap bridge.

    A Snap-confined Firefox cannot execute the host's `pass`/`gpg` binaries
    (the snap runtime shadows /usr and AppArmor forbids running the host
    binaries via hostfs). It *can*, however, connect to a Unix domain socket
    located in its own writable area under the real home directory.

    This daemon runs OUTSIDE the snap confinement (as a systemd --user
    service), listens on that socket and, for every connection, speaks the
    Native Messaging framing (a 4-byte native-endian length prefix followed by
    a JSON payload). Each decoded request is handed to passff.process_message()
    — the very same code path the regular stdio host uses — so pass/gpg run with
    full access to ~/.password-store and ~/.gnupg.

    Usage: passff-host-daemon.py /path/to/passff-host.sock
"""

import json
import os
import socket
import struct
import sys
import threading

# passff.py is installed next to this daemon; reuse its request handling so the
# pass/gpg logic exists in exactly one place.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import passff  # noqa: E402


def _read_exactly(conn, length):
    """ Read exactly `length` bytes from the socket, or return None on EOF. """
    chunks = []
    remaining = length
    while remaining > 0:
        chunk = conn.recv(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_frame(conn, message_dict):
    """ Encode message_dict as a Native Messaging frame and send it. The length
        prefix counts BYTES (not characters) so multi-byte payloads stay valid. """
    payload = json.dumps(message_dict).encode(passff.CHARSET)
    conn.sendall(struct.pack("@I", len(payload)) + payload)


def handle_connection(conn):
    """ Serve one client. PassFF normally sends a single request per connection,
        but we loop so long-lived connectNative ports work too. """
    try:
        while True:
            raw_length = _read_exactly(conn, 4)
            if raw_length is None:
                break
            message_length = struct.unpack("@I", raw_length)[0]
            raw_message = _read_exactly(conn, message_length)
            if raw_message is None:
                break
            received = json.loads(raw_message.decode(passff.CHARSET))
            _send_frame(conn, passff.process_message(received))
    except (OSError, ValueError):
        # Drop misbehaving clients silently; never crash the daemon.
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: passff-host-daemon.py SOCKET_PATH\n")
        sys.exit(1)
    socket_path = sys.argv[1]

    # Remove a stale socket left behind by a previous run.
    if os.path.exists(socket_path):
        try:
            os.unlink(socket_path)
        except OSError:
            pass

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    # Only the user may talk to the socket.
    os.chmod(socket_path, 0o600)
    server.listen(8)

    try:
        while True:
            conn, _ = server.accept()
            threading.Thread(
                target=handle_connection, args=(conn,), daemon=True
            ).start()
    finally:
        server.close()
        try:
            os.unlink(socket_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
