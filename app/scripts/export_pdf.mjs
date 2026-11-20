// Saves the deck as a PDF, one 1920×1080 page per slide.
// Usage: node scripts/export_pdf.mjs [deck url] [output.pdf]
// The deck is opened with ?print: every slide in its final state, the shader drawn
// once into an image and the videos replaced with a still frame.
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:3000/slides/";
const out = process.argv[3] ?? "slides.pdf";

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(`${url}${url.includes("?") ? "&" : "?"}print`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
// Both shader slides hand their frame over as a PNG data URL.
await page.waitForFunction(() => document.querySelectorAll('img[src^="data:image/"]').length >= 2, null, { timeout: 30000 });
await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 30000 });
await page.emulateMedia({ media: "print" });
await page.pdf({ path: out, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log(out);
