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


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
