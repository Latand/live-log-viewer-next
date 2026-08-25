import { expect, test } from "bun:test";
import path from "node:path";

test("vendored chat listings enforce bounded valid pagination before Telegram I/O", () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const chats = path.resolve(import.meta.dir, "..", "..", "..", "vendor", "telegram-mcp", "telegram_mcp", "tools", "chats.py");
  const harness = String.raw`
import ast
import asyncio
import sys

source = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(source)
selected = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(getattr(target, "id", "") in {"MAX_CHAT_PAGE", "MAX_CHAT_PAGE_SIZE"} for target in node.targets):
        selected.append(node)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {"get_chats", "list_chats"}:
        node.decorator_list = []
        selected.append(node)

calls = []
class Client:
    async def get_dialogs(self, **kwargs):
        calls.append(kwargs)
        return []
client = Client()

async def ensure_connected(_client): pass
def get_client(_account): return client
def format_tool_result(value): return repr(value)
def log_and_format_error(name, error, **kwargs): return f"{name}: {error}"

namespace = {
    "ensure_connected": ensure_connected,
    "get_client": get_client,
    "format_tool_result": format_tool_result,
    "log_and_format_error": log_and_format_error,
}
exec(compile(ast.Module(body=selected, type_ignores=[]), sys.argv[1], "exec"), namespace)

async def main():
    get_chats = namespace["get_chats"]
    list_chats = namespace["list_chats"]
    assert await get_chats(page=0) == "Error: page must be an integer between 1 and 10."
    assert await get_chats(page=True) == "Error: page must be an integer between 1 and 10."
    assert await get_chats(page=11) == "Error: page must be an integer between 1 and 10."
    assert await get_chats(page_size=101) == "Error: page_size must be an integer between 1 and 100."
    assert await get_chats(page_size=0) == "Error: page_size must be an integer between 1 and 100."
    assert calls == []
    assert await get_chats(page=2, page_size=3) == "Page out of range."
    assert calls[-1] == {"limit": 6}

    count = len(calls)
    assert await list_chats(limit=101) == "Error: limit must be an integer between 1 and 100."
    assert await list_chats(limit=False) == "Error: limit must be an integer between 1 and 100."
    assert len(calls) == count
    assert await list_chats(limit=3) == "No chats found matching the criteria."
    assert calls[-1] == {"limit": 3, "archived": None}

asyncio.run(main())
`;
  const result = Bun.spawnSync([python!, "-c", harness, chats], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
