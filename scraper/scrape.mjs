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

// Write only when the meaningful content (date + tiles) differs from what's on
// disk, so an unchanged puzzle doesn't churn the file just because `fetched_at`
// is a fresh timestamp. Returns true if it wrote. Keeps every run idempotent for
// both the Mac mini and the GitHub Action.
function writeIfChanged(filePath, payload) {
    if (fs.existsSync(filePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const same =
                existing.date === payload.date &&
                Array.isArray(existing.tiles) &&
                existing.tiles.length === payload.tiles.length &&
                existing.tiles.every((t, i) => t === payload.tiles[i]);
            if (same) {
                console.log(`Unchanged, skipping write: ${filePath}`);
                return false;
            }
        } catch {
            // Corrupt/unreadable existing file — fall through and overwrite.
        }
    }
    writeJsonAtomic(filePath, payload);
    return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractTilesFromDOM(page) {
    const tiles = page.locator(TILE_SELECTOR);
    // The board renders only after the "Play" splash is dismissed. Clicking too
    // early (before React attaches the handler) is a silent no-op, so poll: click
    // Play whenever it's visible and the board hasn't appeared yet. This absorbs
    // any hydration timing instead of betting on a single fixed delay.
    const playButton = page.getByTestId("moment-btn-play");
    for (let i = 0; i < 20; i++) {
        if ((await tiles.count()) === 16) break;
        if (await playButton.isVisible().catch(() => false)) {
            console.log("Clicking 'Play' button...");
            await playButton.click().catch(() => {});
        }
        await page.waitForTimeout(1500);
    }

    // Final guard: make sure all 16 tiles are actually present before reading.
    await page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length === 16,
        TILE_SELECTOR,
        { timeout: 15000 }
    );

    return await page.evaluate((sel) => {
        const nodes = document.querySelectorAll(sel);
        return Array.from(nodes).map((el) => {
            // NYT renders each tile word TWICE inside the label: a hidden
            // "reference" span (used for font sizing, aria-hidden) plus the
            // visible span. So el.textContent concatenates both copies and
            // yields e.g. "HOLEHOLE". Read an explicit single-value source
            // instead. The hidden checkbox input carries the clean word in its
            // value/aria-label; the label also mirrors it in data-flip-id.
            const input = el.querySelector("input[value]");
            if (input && input.value.trim()) return input.value.trim();
            const flipId = (el.getAttribute("data-flip-id") || "").trim();
            if (flipId) return flipId;
            // Fallback: collapse identical duplicated child spans. Genuine
            // single-copy tiles (incl. real doubled words like "TUTU") have one
            // distinct value and pass through unchanged.
            const spans = Array.from(el.querySelectorAll("span"))
                .map((s) => (s.textContent || "").trim())
                .filter((s) => s.length > 0);
            const distinct = [...new Set(spans)];
            if (distinct.length === 1) return distinct[0];
            return (el.textContent || "").trim();
        });
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

        const wroteDated = writeIfChanged(path.join(OUT_DIR, `${date}.json`), payload);
        const wroteLatest = writeIfChanged(path.join(OUT_DIR, "latest.json"), payload);
        console.log(wroteDated || wroteLatest ? "Data written." : "No changes; nothing written.");
    } finally {
        await browser.close();
        console.log("Browser closed.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
