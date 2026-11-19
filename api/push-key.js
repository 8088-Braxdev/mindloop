// api/push-key.js
// Hands the browser the public half of the VAPID key pair. The private key
// never leaves the server: it stays in the deployment's environment variables.

export default function handler(req, res) {
  if (req.method !== "GET") {
    return res
      .status(405)
      .json({ status: "error", code: "method", message: "Use GET." });
  }
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  if (!publicKey) {
    console.error("MindLoop push: VAPID_PUBLIC_KEY is not set");
    return res.status(500).json({
      status: "error",
      code: "setup",
      message: "Closed-app reminders are not set up yet.",
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ status: "ok", publicKey });
}
