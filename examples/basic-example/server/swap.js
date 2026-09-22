/**
 * CLI Tool to Swap Flags on the running Togglekit Server
 *
 * Usage:
 *   node swap.js
 *   node swap.js http://127.0.0.1:3000
 */

const targetUrl = process.argv[2] ?? process.env.TOGGLEKIT_URL ?? "http://127.0.0.1:3000";

try {
  console.log(`Sending swap command to ${targetUrl}/api/swap ...`);
  const res = await fetch(`${targetUrl}/api/swap`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  console.log("\n✅ Flags swapped successfully on server! (SSE broadcast dispatched)\n");
  console.log("Current Flag Values:");
  console.table(data.flags);
  console.log(`Cycle: #${data.cycle}\n`);
} catch (err) {
  console.error("❌ Failed to swap flags:", err.message);
  console.error("Make sure the Togglekit demo server is running: npm run demo");
  process.exit(1);
}
