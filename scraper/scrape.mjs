import fs from "node:fs";
import path from "node:path";
import playwright from "playwright";
const { chromium } = playwright;

const NYT_URL = "https://www.nytimes.com/games/connections";
const OUT_DIR = path.resolve("docs", "data");
const TILE_SELECTOR = 'label[data-testid="card-label"]';
const MAX_ATTEMPTS = 3;
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractTilesFromDOM(page) {
    // Dismiss the splash screen if present so the grid renders.
    const playButton = page.getByRole("button", { name: /Play/i });
    if (await playButton.count().then((n) => n > 0 && playButton.first().isVisible()).catch(() => false)) {
        console.log("Clicking 'Play' button...");
        await playButton.first().click().catch(() => {});
    }

    // Wait for the grid to actually be present rather than guessing with a fixed delay.
    // This is the main flakiness fix: slow loads now wait, they don't fail.
    await page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length === 16,
        TILE_SELECTOR,
        { timeout: 30000 }
    );

    return await page.evaluate((sel) => {
        const nodes = document.querySelectorAll(sel);
        return Array.from(nodes).map((el) => (el.textContent || "").trim());
    }, TILE_SELECTOR);
}

async function scrapeOnce(browser) {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    try {
        console.log(`Navigating to ${NYT_URL}...`);
        await page.goto(NYT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
        console.log("Page loaded (domcontentloaded).");

        const tiles = await extractTilesFromDOM(page);
        console.log(`Extracted ${tiles.length} tiles:`, tiles);

        if (tiles.length !== 16) {
            throw new Error(`Failed to extract 16 tiles; got ${tiles.length}. Found: ${tiles.join(", ")}`);
        }
        return tiles;
    } catch (err) {
        // Capture what the page looked like on the final failure for debugging.
        await page.screenshot({ path: "failure.png", fullPage: true }).catch(() => {});
        throw err;
    } finally {
        await page.close();
    }
}

async function main() {
    const date = ymdUTC();
    const browser = await chromium.launch({ headless: true });

    try {
        let tiles;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}...`);
                tiles = await scrapeOnce(browser);
                break;
            } catch (err) {
                console.error(`Attempt ${attempt} failed:`, err.message);
                if (attempt === MAX_ATTEMPTS) throw err;
                const backoff = 5000 * attempt;
                console.log(`Retrying in ${backoff / 1000}s...`);
                await sleep(backoff);
            }
        }

        const payload = {
            date,
            tiles,
            fetched_at: new Date().toISOString(),
            source: NYT_URL
        };

        writeJsonAtomic(path.join(OUT_DIR, `${date}.json`), payload);
        writeJsonAtomic(path.join(OUT_DIR, "latest.json"), payload);
        console.log("Data written successfully.");
    } finally {
        await browser.close();
        console.log("Browser closed.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
