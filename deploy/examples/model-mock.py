"""Deterministic local OpenAI-compatible smoke mock; not an AI model.

It answers embeddings, chat and page-extraction calls, and it drives the tool loop of
`flows/04-tool-use-with-approval.yaml`: whatever tools a flow offers are called in the order the
flow declares them, one per round, with arguments filled from each tool's own schema. That is a
script, not a decision - which is exactly why the tool path can be demonstrated offline. The
approvals, the identity injection and the database writes are all real.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Invented arguments for the quickstart's demo tools, keyed by property name. Nothing here reads
# the conversation, so the answers stay reproducible; unknown required properties fall back to a
# neutral placeholder of the right type.
_MOCK_ARGUMENTS = {"subject": "Quickstart: login page shows a blank screen"}
_MOCK_TYPE_VALUES = {
    "number": 1,
    "integer": 1,
    "boolean": False,
    "array": [],
    "object": {},
}

# Markers the runtime puts in front of retrieved context: the fused source block
# (RAG_CONTEXT_MARKER in apps/runtime/src/graph/exec-runtime.ts) and the grounding
# headings (apps/runtime/src/graph/rag-grounding.ts). Seeing one means this request
# is a grounded answer call - the retrieval ran and its result is in the prompt. The
# mock then answers with one sentence copied out of the seeded handbook and cites it,
# which is exactly what makes the citation path of flows/03-grounded-retrieval.yaml
# visible without a real model.
_GROUNDING_MARKERS = (
    "The following sources are ordered by relevance",
    "RELEVANT PASSAGES",
    "RELEVANT SOURCES",
    "COLLECTION OVERVIEW",
)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _tool_call(self, request: dict, name: str, arguments: str) -> None:
        """Answer an offered-tool request with the next scripted tool call."""
        call = {
            "id": f"quickstart-call-{_tool_round(request)}",
            "type": "function",
            "index": 0,
            "function": {"name": name, "arguments": arguments},
        }
        model = request.get("model", "example-chat")
        if request.get("stream") is not True:
            self._json(
                200,
                {
                    "id": "chatcmpl-quickstart",
                    "object": "chat.completion",
                    "created": 0,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                },
            )
            return
        base = {"id": "chatcmpl-quickstart", "object": "chat.completion.chunk", "created": 0, "model": model}
        chunks = [
            {
                **base,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "tool_calls": [call]},
                        "finish_reason": None,
                    }
                ],
            },
            {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
        ]
        body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        encoded = body.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

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
            # One scripted tool call per round, before anything is answered in prose. The runtime
            # executes it against Gate and sends the result back; that result is what makes the
            # write tool stop in the reviewer inbox.
            offered = _offered_tool(request)
            if offered is not None:
                self._tool_call(request, offered[0], offered[1])
                return
            content = "ATF quickstart is running with a deterministic mock model."
            if _has_grounding(request):
                # A grounded call. The one sentence below is copied verbatim from
                # demo/handbook.md - the document the seed service ingests - and cited as [1],
                # the number the runtime gives the only seeded document. The mock neither picks
                # the citation nor understands the text; a real model answers from the passage.
                content = (
                    "According to the field service handbook, the support desk answers from "
                    "07:00 to 19:00 Central European Time, Monday to Friday [1]. The mock model "
                    "copies this sentence out of the retrieved passage and adds nothing to it."
                )
            if _tool_round(request) > 0:
                # Reached once the declared tools have been called, so the answer names what ran.
                # It reports the round trip only - the mock never claims to have decided anything.
                content = (
                    f"ATF quickstart: {_tool_round(request)} tool call(s) went through Gate and "
                    "their results came back. The mock model adds nothing on top of them."
                )
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


def _has_grounding(request: object) -> bool:
    """True when the prompt carries a retrieved-passage section from the runtime."""
    if not isinstance(request, dict):
        return False
    for message in request.get("messages", []):
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and any(marker in content for marker in _GROUNDING_MARKERS):
            return True
    return False


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


def _tool_round(request: object) -> int:
    """Number of tool results the conversation already holds, i.e. the script position."""
    if not isinstance(request, dict):
        return 0
    messages = request.get("messages")
    if not isinstance(messages, list):
        return 0
    return sum(
        1 for message in messages if isinstance(message, dict) and message.get("role") == "tool"
    )


def _offered_tool(request: object) -> tuple[str, str] | None:
    """The next tool call of the script: name plus JSON arguments, or None when done.

    Tool names are echoed back exactly as offered, because the runtime maps them to MCP tools and
    may have rewritten the ID for the provider's naming rules.
    """
    if not isinstance(request, dict):
        return None
    tools = request.get("tools")
    if not isinstance(tools, list) or len(tools) == 0:
        return None
    index = _tool_round(request)
    tool = tools[index] if index < len(tools) else None
    if not isinstance(tool, dict):
        return None
    function = tool.get("function") if isinstance(tool.get("function"), dict) else tool
    name = function.get("name")
    if not isinstance(name, str) or name == "":
        return None
    return name, json.dumps(_arguments_for(function))


def _arguments_for(function: dict) -> dict:
    """Fill every required property of the tool's own schema with an invented value."""
    schema = function.get("parameters")
    if not isinstance(schema, dict):
        schema = function.get("inputSchema")
    if not isinstance(schema, dict):
        return {}
    required = schema.get("required")
    properties = schema.get("properties")
    if not isinstance(required, list):
        return {}
    arguments: dict = {}
    for key in required:
        if not isinstance(key, str):
            continue
        declared = properties.get(key) if isinstance(properties, dict) else None
        kind = declared.get("type") if isinstance(declared, dict) else None
        arguments[key] = _MOCK_ARGUMENTS.get(key, _MOCK_TYPE_VALUES.get(str(kind), "placeholder"))
    return arguments


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
