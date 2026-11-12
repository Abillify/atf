# -*- coding: utf-8 -*-
"""One-shot seed: load the quickstart handbook into Search.

A retrieval flow is only convincing if it retrieves something, so the quickstart
ships one invented document (`handbook.md`) and this script posts it to
`POST /ingest` — the same endpoint the real ingest integrations use, with the
same headers. It is not special-cased anywhere in Search.

Idempotent by design: Search identifies a document by its `X-Reference` and
recognises identical bytes (sha256) as a duplicate, so re-running this script —
`docker compose ... up` a second time, or `docker compose ... restart seed` —
re-places the same document instead of accumulating copies. Only a `down -v`
(fresh Postgres volume) makes it a first ingest again.

Uses only the Python standard library: the image is already in the stack for
`model-mock`, so seeding adds no new dependency to pull.
"""

import sys
import time
import urllib.error
import urllib.request

SEARCH_URL = "http://search:3000"
HANDBOOK = "/handbook/handbook.md"
# The collection flow 03 (`flows/03-grounded-retrieval.yaml`) reads from.
COLLECTION = "handbook"
# Stable document identity: the seed replaces its own document on every run
# rather than appending one.
REFERENCE = "handbook.md"
TITLE = "Northwind Cartography - Field Service Handbook"


def wait_for_search(attempts: int = 60) -> None:
    """Block until Search answers /health; compose already gates on its health,
    this only absorbs the last race between 'healthy' and 'serving'."""
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(f"{SEARCH_URL}/health", timeout=5):
                return
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(2)
    raise SystemExit(f"search never became reachable at {SEARCH_URL}")


def ingest(markdown: bytes) -> str:
    request = urllib.request.Request(
        f"{SEARCH_URL}/ingest",
        data=markdown,
        method="POST",
        headers={
            # The body is the document itself, Markdown like the real
            # integrations send it.
            "Content-Type": "text/markdown",
            "X-Reference": REFERENCE,
            "X-Collection": COLLECTION,
            "X-Title": TITLE,
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read().decode(errors="replace")
        return f"{response.status} {body[:200]}"


def main() -> None:
    with open(HANDBOOK, "rb") as handle:
        markdown = handle.read()
    wait_for_search()
    result = ingest(markdown)
    print(f"seed: POST /ingest -> {result}")
    print(f"seed: collection {COLLECTION!r} now holds {REFERENCE!r}")


if __name__ == "__main__":
    sys.exit(main())
