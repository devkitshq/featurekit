/**
 * `npm run demo:lan` — the same demo, bound to every interface.
 *
 * A phone cannot reach `127.0.0.1` on your laptop, so `examples/mobile` needs
 * the control plane and the config endpoint listening on the network. That is
 * a deliberate command rather than the default: `npm run demo` should not put a
 * database and an admin dashboard on the coffee shop's Wi-Fi.
 *
 * A one-line wrapper rather than `HOST=0.0.0.0 npm run demo`, which is not a
 * thing you can type on Windows.
 */

process.env.HOST = process.env.HOST ?? "0.0.0.0";
await import("./server.js");
