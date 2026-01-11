import fs from "node:fs";
import path from "node:path";
import playwright from "playwright";
const { chromium } = playwright;

const NYT_URL = "https://www.nytimes.com/games/connections";
const OUT_DIR = path.resolve("docs", "data");

function ymdUTC(d = new Date()) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function writeJsonAtomic(filePath, obj) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
}

function looksLikeTile(s) {
    // Conservative heuristic; you will refine this after one live run.
    if (!s) return false;
    if (s.length < 2 || s.length > 30) return false;
    // NYT tiles are typically uppercase words/phrases; allow spaces/apostrophes/hyphens.
    if (!/^[A-Z0-9' -]+$/.test(s)) return false;
    return true;
}

async function extractTilesFromDOM(page) {
    // First, check for and click the "Play" button if it exists (splash screen)
    const playButton = page.getByRole("button", { name: /Play/i });
    if (await playButton.isVisible()) {
        console.log("Clicking 'Play' button...");
        await playButton.click();
        // Wait for the grid to animate in
        await page.waitForTimeout(1000);
    }

    return await page.evaluate(() => {
        // NYT uses label[data-testid="card-label"] for the tiles
        const nodes = document.querySelectorAll('label[data-testid="card-label"]');
        return Array.from(nodes).map(el => (el.textContent || "").trim());
    });
}

async function main() {
    const date = ymdUTC();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    });

    console.log(`Navigating to ${NYT_URL}...`);
    await page.goto(NYT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(5000); // Wait for potential redirects/overlays

    // Grab candidate texts in page order.
    const tiles = await extractTilesFromDOM(page);
    console.log(`Extracted ${tiles.length} tiles.`);

    await browser.close();

    if (tiles.length !== 16) {
        throw new Error(`Failed to extract 16 tiles; got ${tiles.length}. Found: ${tiles.join(', ')}`);
    }

    const payload = {
        date,
        tiles,
        fetched_at: new Date().toISOString(),
        source: NYT_URL
    };

    // Write dated + latest
    writeJsonAtomic(path.join(OUT_DIR, `${date}.json`), payload);
    writeJsonAtomic(path.join(OUT_DIR, "latest.json"), payload);
    console.log(`Data written to ${path.join(OUT_DIR, "latest.json")}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
