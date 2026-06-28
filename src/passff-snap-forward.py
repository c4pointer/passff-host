#!/usr/bin/env python3
"""
    Snap-side forwarder for the PassFF Snap bridge.

    This is the program the Snap-confined Firefox actually launches (via the
    generated passff-wrapper.sh). It runs inside the snap confinement using the
    snap runtime's python3, and does nothing but bridge the Native Messaging
    stream to the host daemon:

        Firefox stdin  --> Unix socket --> daemon (host)
        Firefox stdout <-- Unix socket <-- daemon (host)

    It MUST NOT write anything to stdout other than the bytes coming back from
    the daemon — stdout carries the binary Native Messaging protocol and any
    stray byte would corrupt it. Diagnostics, if any, go to stderr.

    Usage: passff-snap-forward.py /path/to/passff-host.sock
"""

import os
import select
import socket
import sys

BUFSIZE = 65536


def main():
    sock_path = (
        sys.argv[1] if len(sys.argv) > 1
        else os.path.join(os.path.expanduser("~"), "passff-host.sock")
    )

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
    except OSError as exc:
        # Surface the failure on stderr so it shows up in the browser console,
        # then exit non-zero. Nothing is written to stdout.
        sys.stderr.write(
            "passff: cannot reach host daemon at %s: %s\n" % (sock_path, exc)
        )
        return 1

    stdin_fd = sys.stdin.buffer.fileno()
    stdout_fd = sys.stdout.buffer.fileno()
    sock_fd = sock.fileno()

    stdin_open = True
    try:
        while True:
            watch = [sock_fd]
            if stdin_open:
                watch.append(stdin_fd)
            readable, _, _ = select.select(watch, [], [])

            if stdin_open and stdin_fd in readable:
                data = os.read(stdin_fd, BUFSIZE)
                if not data:
                    # Browser closed its end: half-close the socket so the
                    # daemon sees EOF, but keep reading the response.
                    stdin_open = False
                    try:
                        sock.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                else:
                    sock.sendall(data)

            if sock_fd in readable:
                data = sock.recv(BUFSIZE)
                if not data:
                    break
                os.write(stdout_fd, data)
    finally:
        sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
