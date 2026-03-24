import http from "node:http";

const server = http.createServer((req, res) => {
  const payload = {
    ok: true,
    path: req.url,
    method: req.method,
    message: "Hello from mock upstream"
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
});

server.listen(5050, "127.0.0.1", () => {
  console.log("Mock upstream running on http://127.0.0.1:5050");
});
