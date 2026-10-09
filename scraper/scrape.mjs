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

// Puzzle day is defined in US Eastern time (new board drops at 03:00 ET).
function ymdET(d = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(d); // en-CA formats as YYYY-MM-DD
}

const API_URL = (date) => `https://www.nytimes.com/svc/connections/v2/${date}.json`;

// Primary source: the JSON the game itself loads. No browser, no splash screen,
// no DOM selectors. Returns the 16 tiles in starting-board order (by `position`)
// and deliberately drops the group answers so the stored format is unchanged.
async function fetchTilesFromApi(date) {
    const url = API_URL(date);
    console.log(`Fetching ${url}...`);
    const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
    });
    if (!res.ok) throw new Error(`API HTTP ${res.status} for ${url}`);
    const data = await res.json();
    if (!Array.isArray(data.categories)) {
        throw new Error(`API response has no categories array (keys: ${Object.keys(data).join(", ")})`);
    }
    const board = new Array(16).fill(null);
    for (const cat of data.categories) {
        for (const card of cat.cards || []) {
            const word = (card.content || "").trim();
            const pos = card.position;
            if (!word) throw new Error(`API card with no text content (image puzzle?): ${JSON.stringify(card)}`);
            if (!Number.isInteger(pos) || pos < 0 || pos >= 16) throw new Error(`API card bad position: ${JSON.stringify(card)}`);
            if (board[pos] !== null) throw new Error(`API duplicate position ${pos}`);
            board[pos] = word;
        }
    }
    const missing = board.flatMap((w, i) => (w === null ? [i] : []));
    if (missing.length) throw new Error(`API board missing positions: ${missing.join(", ")}`);
    if (data.print_date && data.print_date !== date) {
        throw new Error(`API print_date ${data.print_date} != requested ${date}`);
    }
    return board;
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
            // Same day, different board: NYT swapped a queued puzzle. Say so.
            if (existing.date === payload.date && Array.isArray(existing.tiles) && !filePath.endsWith("latest.json")) {
                const was = new Set(existing.tiles);
                const now = new Set(payload.tiles);
                const removed = existing.tiles.filter((t) => !now.has(t));
                const added = payload.tiles.filter((t) => !was.has(t));
                console.warn(
                    `NYT CHANGED ${payload.date}: ` +
                    (removed.length || added.length
                        ? `removed [${removed.join(", ")}] added [${added.join(", ")}]`
                        : "same words, new order")
                );
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
        // Dump DOM hooks so a selector change is diagnosable from the log alone.
        const diag = await page
            .evaluate((sel) => ({
                url: location.href,
                title: document.title,
                tileCount: document.querySelectorAll(sel).length,
                testids: [...new Set([...document.querySelectorAll("[data-testid]")]
                    .map((e) => `${e.tagName.toLowerCase()}[data-testid="${e.dataset.testid}"]`))],
                bodyText: (document.body?.innerText || "").slice(0, 600)
            }), TILE_SELECTOR)
            .catch((e) => ({ error: e.message }));
        console.error("DOM diagnostics:", JSON.stringify(diag, null, 2));
        throw err;
    } finally {
        await page.close();
    }
}

async function scrapeViaBrowser() {
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
        return tiles;
    } finally {
        await browser.close();
        console.log("Browser closed.");
    }
}

// How many days past today to prefetch. NYT publishes boards weeks ahead, and
// readers east of New York (Europe, Asia, Oceania) hit their local "today"
// before our 03:10 ET run. One day covers every time zone; the rest is slack
// in case the mini misses a few nights.
const LOOKAHEAD_DAYS = 7;

function addDays(ymd, n) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function save(date, tiles, source, isToday) {
    const payload = { date, tiles, fetched_at: new Date().toISOString(), source };
    const wroteDated = writeIfChanged(path.join(OUT_DIR, `${date}.json`), payload);
    // Only advance latest.json for today's puzzle, never for backfill or future.
    const wroteLatest = isToday && writeIfChanged(path.join(OUT_DIR, "latest.json"), payload);
    return wroteDated || wroteLatest;
}

async function main() {
    // Optional date override for a single backfill: node scrape.mjs 2026-10-06
    const arg = process.argv[2];
    if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error(`Bad date argument "${arg}", want YYYY-MM-DD`);
    const today = ymdET();

    if (arg) {
        const tiles = await fetchTilesFromApi(arg); // browser can't see other days
        console.log(`Tiles for ${arg}:`, tiles);
        console.log(save(arg, tiles, API_URL(arg), arg === today) ? "Data written." : "No changes; nothing written.");
        return;
    }

    // Today is mandatory: API first, browser fallback, fail loudly if both fail.
    let tiles;
    let source;
    try {
        tiles = await fetchTilesFromApi(today);
        source = API_URL(today);
        console.log("Got today's tiles from API.");
    } catch (err) {
        console.error(`API path failed: ${err.message}`);
        console.log("Falling back to browser scrape...");
        tiles = await scrapeViaBrowser();
        source = NYT_URL;
    }
    console.log(`Today ${today} (${tiles.length}):`, tiles);
    const written = [];
    if (save(today, tiles, source, true)) written.push(today);

    // Future days are best effort: a miss is expected near the end of what NYT
    // has published, so it is reported, not fatal.
    const skipped = [];
    for (let i = 1; i <= LOOKAHEAD_DAYS; i++) {
        const d = addDays(today, i);
        try {
            const t = await fetchTilesFromApi(d);
            if (save(d, t, API_URL(d), false)) written.push(d);
        } catch (err) {
            skipped.push(`${d} (${err.message})`);
        }
    }

    console.log(written.length ? `Written: ${written.join(", ")}` : "No changes; nothing written.");
    if (skipped.length) console.warn(`Lookahead skipped ${skipped.length}/${LOOKAHEAD_DAYS}:\n  ${skipped.join("\n  ")}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
