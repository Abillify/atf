# Deterministic OpenAI-compatible chat mock for the retrieval eval stack.
#
# Serves ONLY the chat-completions surface the Search HyDE expansion needs
# (HYDE_URL). Embeddings and reranking are served by real TEI models in
# compose.eval.yaml — this mock exists so HyDE has a deterministic, offline
# "hypothetical document" generator: it turns the query into a fixed pseudo-document
# sentence. The eval therefore measures the SHAPE of HyDE (an expanded query is
# embedded and searched) without pretending to measure a real LLM's quality.
#
# Usage: python3 echo-mock.py [port]   (default 8080)

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "echo-hyde"


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
            self._json(
                200,
                {
                    "object": "list",
                    "data": [{"id": MODEL, "object": "model", "owned_by": "eval"}],
                },
            )
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        request = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/v1/chat/completions":
            query = ""
            for message in request.get("messages", []):
                if message.get("role") == "user":
                    query = str(message.get("content", ""))
            # A deterministic "hypothetical document": a fixed sentence frame
            # around the query, so the expanded query embeds as a document-like
            # string. Same query in, same expansion out — reproducible metrics.
            expansion = (
                "Dieses Dokument beschreibt: " + query.strip().rstrip("?") + "."
            )
            self._json(
                200,
                {
                    "id": "echo-1",
                    "object": "chat.completion",
                    "model": request.get("model", MODEL),
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": expansion},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                },
            )
            return
        self._json(404, {"error": "not_found"})

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        sys.stderr.write("echo-mock: " + (format % args) + "\n")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"echo-mock listening on :{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
