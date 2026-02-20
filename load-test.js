const baseUrl = process.argv[2] || "http://localhost:3000";
const targetPath = process.argv[3] || "/health";
const totalRequests = Math.max(1, Number(process.argv[4] || 200));
const concurrency = Math.max(1, Number(process.argv[5] || 20));
const method = (process.argv[6] || "GET").toUpperCase();

function buildRequest(index) {
  const url = `${baseUrl}${targetPath}`;

  if (method === "POST" && targetPath.includes("/api/inquiries")) {
    const body = new URLSearchParams({
      "full-name": `Load Test User ${index}`,
      company: "Load Test",
      email: `load${index}@example.com`,
      "service-type": "support",
      details: `Load test request ${index}`,
      website: ""
    });

    return {
      url,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    };
  }

  return {
    url,
    init: {
      method,
      headers: { Accept: "application/json" }
    }
  };
}

async function run() {
  const startedAt = Date.now();
  let sent = 0;
  let completed = 0;
  let ok = 0;
  let rateLimited = 0;
  let failed = 0;
  const statusCounts = new Map();
  const latencyMs = [];

  async function worker() {
    while (true) {
      const index = sent;
      if (index >= totalRequests) {
        return;
      }
      sent += 1;

      const { url, init } = buildRequest(index + 1);
      const start = Date.now();

      try {
        const response = await fetch(url, init);
        const elapsed = Date.now() - start;
        latencyMs.push(elapsed);

        const status = response.status;
        statusCounts.set(status, (statusCounts.get(status) || 0) + 1);

        if (status >= 200 && status < 300) {
          ok += 1;
        } else if (status === 429) {
          rateLimited += 1;
        } else {
          failed += 1;
        }
      } catch (_error) {
        const elapsed = Date.now() - start;
        latencyMs.push(elapsed);
        failed += 1;
      } finally {
        completed += 1;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const durationMs = Date.now() - startedAt;
  const rps = (completed / (durationMs / 1000)).toFixed(2);
  latencyMs.sort((a, b) => a - b);

  const p50 = latencyMs[Math.floor(latencyMs.length * 0.5)] || 0;
  const p95 = latencyMs[Math.floor(latencyMs.length * 0.95)] || 0;
  const p99 = latencyMs[Math.floor(latencyMs.length * 0.99)] || 0;

  console.log("\n=== Load Test Result ===");
  console.log(`Target      : ${method} ${baseUrl}${targetPath}`);
  console.log(`Requests    : ${totalRequests}`);
  console.log(`Concurrency : ${concurrency}`);
  console.log(`Duration    : ${durationMs} ms`);
  console.log(`Throughput  : ${rps} req/s`);
  console.log(`Success     : ${ok}`);
  console.log(`RateLimited : ${rateLimited}`);
  console.log(`Failed      : ${failed}`);
  console.log(`Latency p50 : ${p50} ms`);
  console.log(`Latency p95 : ${p95} ms`);
  console.log(`Latency p99 : ${p99} ms`);

  const sortedStatuses = Array.from(statusCounts.entries()).sort((a, b) => a[0] - b[0]);
  console.log("Status counts:");
  for (const [status, count] of sortedStatuses) {
    console.log(`  ${status}: ${count}`);
  }
}

run().catch((error) => {
  console.error("Load test failed:", error);
  process.exit(1);
});
