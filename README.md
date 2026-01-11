# NYT Connections Scraper

This project automatically scrapes the daily NYT Connections game tiles and saves them as JSON data.

## 🚀 How to Run

### 1. View the Hosted Site (GitHub Pages)
The project is configured to serve the scraped data and a tile sorter tool via GitHub Pages.

**Live Tile Sorter:** [https://wyolum.github.io/nyt-connections-data/nyt_connections_tile_sorter_v6.html](https://wyolum.github.io/nyt-connections-data/nyt_connections_tile_sorter_v6.html)

**Original Puzzle:** [https://www.nytimes.com/games/connections](https://www.nytimes.com/games/connections)

**Data Index:** [https://wyolum.github.io/nyt-connections-data/](https://wyolum.github.io/nyt-connections-data/)

> [!NOTE]
> If the link above doesn't work, ensure GitHub Pages is enabled in your repository settings:
> 1. Go to **Settings** > **Pages**.
> 2. Under **Build and deployment** > **Source**, select **Deploy from a branch**.
> 3. Select the `main` branch and the `/docs` folder.
> 4. Click **Save**.

### 2. Run the Scraper Locally
To run the scraper on your own machine, follow these steps:

1. **Install Dependencies:**
   Navigate to the `scraper` directory and install the required Node.js packages:
   ```bash
   cd scraper
   npm install
   ```

2. **Install Playwright Browsers:**
   The scraper uses Playwright to navigate the NYT website. You need to install the Chromium browser:
   ```bash
   npx playwright install --with-deps chromium
   ```

3. **Execute the Scraper:**
   Run the following command from the root of the project:
   ```bash
   node scraper/scrape.mjs
   ```
   The scraped data will be saved to `docs/data/YYYY-MM-DD.json` and `docs/data/latest.json`.

## 🤖 Automated Scraping
The project includes a GitHub Actions workflow that runs automatically every day at 03:01 EST (08:01 UTC).

- **Workflow File:** `.github/workflows/scrape.yml`
- **Data Location:** All scraped data is stored in the `docs/data/` directory.

## 📁 Repository Structure
- `scraper/`: Contains the scraping script and its dependencies.
- `docs/`: The web root for GitHub Pages, containing the data and a simple viewer.
- `.github/workflows/`: Contains the automation logic.
