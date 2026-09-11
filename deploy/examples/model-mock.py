"""Deterministic local OpenAI-compatible smoke mock; not an AI model."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        elif self.path == "/v1/models":
            # Every OpenAI-compatible server exposes this, and @atf/extract uses it
            # as its readiness probe so a health check spends no tokens.
            self._json(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": "example-chat", "object": "model", "owned_by": "quickstart"},
                        {"id": "example-embedding", "object": "model", "owned_by": "quickstart"},
                        {"id": "example-vision", "object": "model", "owned_by": "quickstart"},
                    ],
                },
            )
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/v1/embeddings":
            value = request.get("input", request.get("inputs", []))
            items = value if isinstance(value, list) else [value]
            self._json(
                200,
                {
                    "object": "list",
                    "model": request.get("model", "example-embedding"),
                    "data": [
                        {"object": "embedding", "index": index, "embedding": [0.0, 0.0, 1.0]}
                        for index, _ in enumerate(items)
                    ],
                    "usage": {"prompt_tokens": 0, "total_tokens": 0},
                },
            )
            return
        if self.path == "/v1/chat/completions":
            content = "ATF quickstart is running with a deterministic mock model."
            if _is_page_extraction(request):
                # @atf/extract expects <summary>, <figures> and <markdown>. Returning
                # prose here would still work — its parser falls back to treating the
                # whole response as the page body — but the quickstart would then
                # demonstrate the fallback rather than the contract.
                content = (
                    "<summary>Eine Beispielseite aus dem ATF-Quickstart.</summary>\n"
                    "<figures>\n"
                    '<figure id="1" bbox="[0.1000, 0.2000, 0.6000, 0.7000]">'
                    "Platzhalterabbildung des deterministischen Mock-Modells."
                    "</figure>\n"
                    "</figures>\n"
                    "<markdown>\n"
                    "# Beispielseite\n\n"
                    "Dieser Text stammt aus dem deterministischen Mock-Modell, "
                    "nicht aus einem echten Vision-Modell.\n\n"
                    "![figure_1]\n"
                    "</markdown>"
                )
            if request.get("stream") is True:
                chunks = [
                    {
                        "id": "chatcmpl-quickstart",
                        "object": "chat.completion.chunk",
                        "created": 0,
                        "model": request.get("model", "example-chat"),
                        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
                    },
                    {
                        "id": "chatcmpl-quickstart",
                        "object": "chat.completion.chunk",
                        "created": 0,
                        "model": request.get("model", "example-chat"),
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    },
                ]
                body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
                encoded = body.encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            else:
                self._json(
                    200,
                    {
                        "id": "chatcmpl-quickstart",
                        "object": "chat.completion",
                        "created": 0,
                        "model": request.get("model", "example-chat"),
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                    },
                )
            return
        self._json(404, {"error": "not_found"})

    def log_message(self, *_: object) -> None:
        return


def _is_page_extraction(request: object) -> bool:
    """True when the request carries an image, i.e. it is a page-extraction call."""
    if not isinstance(request, dict):
        return False
    for message in request.get("messages", []):
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list) and any(
            isinstance(part, dict) and part.get("type") == "image_url" for part in content
        ):
            return True
    return False


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
