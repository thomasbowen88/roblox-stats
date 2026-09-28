import fs from "node:fs/promises";
import zlib from "node:zlib";
import { chromium } from "playwright";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function decodeProjectPayload(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const compressed = Buffer.from(padded, "base64");
  return JSON.parse(zlib.gunzipSync(compressed).toString("utf8"));
}

function safeFilename(value) {
  const base = String(value || "markup-image")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "markup-image";
  return `${base}.jpg`;
}

async function callbackError(callbackUrl, token, jobId, error) {
  if (!callbackUrl || !token || !jobId) return;
  try {
    await fetch(callbackUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ job_id: jobId, error: error?.message || String(error) })
    });
  } catch {}
}

async function main() {
  const jobId = required("JOB_ID");
  const projectPayload = required("PROJECT_PAYLOAD");
  const markupUrl = required("MARKUP_URL");
  const callbackUrl = required("CALLBACK_URL");
  const callbackToken = required("CALLBACK_TOKEN");
  const recipe = decodeProjectPayload(projectPayload);
  const browser = await chromium.launch({ headless: true });
  let outputPath = "";

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (error) => console.error("[MarkUP page error]", error));
    await page.goto(markupUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => window.MarkupAutomation?.ready === true, null, { timeout: 90000 });

    const result = await page.evaluate(async (sharedRecipe) => {
      const api = window.MarkupAutomation;
      await api.loadSharedProject(sharedRecipe);
      return api.exportImage({
        format: "image/jpeg",
        quality: 0.95,
        optimizeJpeg: false,
        filename: sharedRecipe.name || "markup-image",
        download: false
      });
    }, recipe);

    if (!result?.dataUrl) throw new Error("MarkUP did not return an image export.");
    const match = String(result.dataUrl).match(/^data:image\/jpeg;base64,(.+)$/);
    if (!match) throw new Error("MarkUP returned an unexpected export format.");
    const bytes = Buffer.from(match[1], "base64");
    const filename = safeFilename(recipe.name);
    outputPath = `/tmp/${filename}`;
    await fs.writeFile(outputPath, bytes);

    const form = new FormData();
    form.set("job_id", jobId);
    form.set("file", new Blob([bytes], { type: "image/jpeg" }), filename);
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${callbackToken}` },
      body: form
    });
    if (!response.ok) throw new Error(`Render callback failed: HTTP ${response.status} ${await response.text()}`);
    console.log(`Rendered ${filename} (${bytes.length} bytes)`);
  } finally {
    await browser.close();
  }

  return outputPath;
}

const callbackUrl = String(process.env.CALLBACK_URL || "").trim();
const callbackToken = String(process.env.CALLBACK_TOKEN || "").trim();
const jobId = String(process.env.JOB_ID || "").trim();

main().catch(async (error) => {
  console.error(error);
  await callbackError(callbackUrl, callbackToken, jobId, error);
  process.exitCode = 1;
});
