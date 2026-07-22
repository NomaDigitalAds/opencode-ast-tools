import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

type ChatRequest = {
  stream?: boolean
  model?: string
  messages?: unknown[]
}

type MockServerOptions = {
  beforeApply?(scenario: string): Promise<void>
}

type ToolCall = {
  name: string
  arguments: Record<string, unknown>
}

const operations = [{ pattern: "console.log($ARG)", replacement: "logger.info($ARG)" }]

function scenarioOf(request: ChatRequest): string {
  return JSON.stringify(request.messages ?? []).match(/SMOKE_[A-Z_]+/)?.[0] ?? ""
}

function toolResults(request: ChatRequest): unknown[] {
  return (request.messages ?? []).filter(
    (message) => message && typeof message === "object" && (message as { role?: unknown }).role === "tool",
  )
}

function nextTool(scenario: string, results: unknown[]): ToolCall | undefined {
  if (results.length === 0) {
    if (scenario === "SMOKE_SEARCH" || scenario === "SMOKE_READ_DENY") {
      return {
        name: "ast_grep_search",
        arguments: { pattern: "console.log($ARG)", language: "typescript", paths: ["src/main.ts"] },
      }
    }
    return {
      name: "ast_grep_replace",
      arguments: { operations, language: "typescript", paths: ["src/main.ts"] },
    }
  }
  if (results.length > 1 || scenario === "SMOKE_PREVIEW") return undefined

  const planId = JSON.stringify(results).match(/[a-f0-9]{32}/)?.[0]
  if (!planId) return undefined
  return { name: "ast_grep_apply", arguments: { planId } }
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function sendStream(response: ServerResponse, model: string, tool: ToolCall | undefined): void {
  const id = `chatcmpl-${Date.now()}`
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  if (tool) {
    response.write(
      `data: ${JSON.stringify(
        chunk(
          id,
          model,
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${Date.now()}`,
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          },
          null,
        ),
      )}\n\n`,
    )
    response.write(`data: ${JSON.stringify(chunk(id, model, {}, "tool_calls"))}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify(chunk(id, model, { role: "assistant", content: "SMOKE_COMPLETE" }, null))}\n\n`)
    response.write(`data: ${JSON.stringify(chunk(id, model, {}, "stop"))}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

function sendJson(response: ServerResponse, model: string, tool: ToolCall | undefined): void {
  const message = tool
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${Date.now()}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      }
    : { role: "assistant", content: "SMOKE_COMPLETE" }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(
    JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  )
}

async function body(request: IncomingMessage): Promise<ChatRequest> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > 8 * 1024 * 1024) throw new Error("mock request exceeded 8 MiB")
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest
}

export async function startMockOpenAI(options: MockServerOptions = {}) {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "mock-model", object: "model", created: 0, owned_by: "ci" }],
          }),
        )
        return
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }

      const input = await body(request)
      const scenario = scenarioOf(input)
      const results = toolResults(input)
      const tool = nextTool(scenario, results)
      if (tool?.name === "ast_grep_apply") await options.beforeApply?.(scenario)
      if (input.stream) sendStream(response, input.model ?? "mock-model", tool)
      else sendJson(response, input.model ?? "mock-model", tool)
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock server did not bind a TCP port")
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
