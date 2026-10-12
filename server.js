// Tiny local server: serves the chat UI and proxies requests to the vLLM
// server on the RunPod pod, so the API key never reaches the browser.
// Run with: npm start
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

const {
  POD_BASE_URL,
  VLLM_API_KEY,
  MODEL = "Qwen/Qwen3-8B",
  PORT = 3001,
} = process.env;
if (!POD_BASE_URL || !VLLM_API_KEY) {
  console.error("Set POD_BASE_URL and VLLM_API_KEY in .env (see .env.example)");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${VLLM_API_KEY}`,
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        return send(res, 200, await readFile("public/index.html", "utf8"), "text/html");
      }
      if (req.method === "GET" && req.url === "/api/health") {
        const r = await fetch(`${POD_BASE_URL}/models`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return send(res, 502, { ok: false, error: `Pod returned ${r.status}` });
        const { data } = await r.json();
        const m = data.find((d) => d.id === MODEL) ?? data[0];
        return send(res, 200, { ok: true, model: m?.id, maxLen: m?.max_model_len });
      }
      if (req.method === "POST" && req.url === "/api/chat") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { messages, temperature = 0.7, thinking = true } = JSON.parse(raw);

        // Stop generating on the pod if the browser hits Stop or closes the tab.
        const abort = new AbortController();
        res.on("close", () => abort.abort());

        const upstream = await fetch(`${POD_BASE_URL}/chat/completions`, {
          method: "POST",
          headers,
          signal: abort.signal,
          body: JSON.stringify({
            model: MODEL,
            messages,
            temperature,
            stream: true,
            chat_template_kwargs: { enable_thinking: thinking },
          }),
        });
        if (!upstream.ok) {
          return send(res, upstream.status, { error: await upstream.text() });
        }
        // Pass the server-sent event stream straight through to the browser.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        return Readable.fromWeb(upstream.body)
          .on("error", () => res.end())
          .pipe(res);
      }
      send(res, 404, { error: "Not found" });
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    }
  })
  .listen(PORT, () => console.log(`Qwen chat running at http://localhost:${PORT}`));
