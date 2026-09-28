# FundFit

Learn how SEBI classifies mutual funds, find the category that fits your money and timeline, and see which AMCs offer it.

A free, static site on GitHub Pages. No backend, no API keys, no tracking. A GitHub Action refreshes the data from AMFI and SEBI every morning.

## What's in it

FundFit is for everyday investors who want to understand mutual funds and pick the kind of fund that suits them. It's built like a game.

| Section | What it does |
|---|---|
| Learn | 10 bite-size lessons on a path, each ending with a one-question check. |
| Fund types | All 40 SEBI fund types as collectible cards, each with its key rule, time horizon and risk. Open a card to see which fund houses offer it and their schemes. |
| Play | Fund Match: 10 quick questions (real-life situations, "name that fund", myth or fact) with a review of every answer. |
| Find my fit | Purpose, SIP or lumpsum and amount, horizon, risk comfort, emergency fund and tax regime lead to a suggested fund type, alternatives, warnings, and the fund houses that offer it. |
| Fund houses | Every AMC in AMFI's daily file, with a strip showing which fund types it offers. |

XP, levels, badges and a daily streak are saved only in the visitor's browser. English and Tanglish toggle. Fonts are self-hosted (Bricolage Grotesque and Figtree, SIL Open Font License), so the site makes no third-party requests.

## How the live data works

```
GitHub Action (daily 08:47 IST, and on every push)
  ├─ node --test            tests the parser and all 2,520 answer combinations
  ├─ scripts/fetch-data.mjs
  │    ├─ AMFI NAVAll.txt  → data/schemes.json   (AMCs, schemes, category, plans, latest NAV)
  │    └─ SEBI RSS feed    → data/sebi.json      (MF-related circulars, rolling 40)
  ├─ commits data/ if it changed
  └─ deploys the site to GitHub Pages
```

Browsers can't read AMFI or SEBI directly (they don't allow cross-site requests), so the Action fetches on GitHub's servers and the site reads the saved JSON.

If AMFI or SEBI is down, the previous data is kept and the site shows how old it is. `data/status.json` records any problems from the last run.

## Set it up

1. Create a public repo (e.g. `fundfit`) and upload everything in this folder, including the hidden `.github` folder.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Repo **Settings → Actions → General → Workflow permissions: Read and write**.
4. **Actions** tab → "Refresh AMFI/SEBI data and deploy" → **Run workflow**. The first run fills `data/schemes.json` and `data/sebi.json`.
5. The site is live at `https://<username>.github.io/<repo>/`.

To preview on your computer, run a local server from this folder (`python3 -m http.server`) and open http://localhost:8000. Opening `index.html` directly won't load the data files.

## What to maintain by hand

**Category rules** live in `data/categories.json`. The Action never edits them; SEBI circulars need a human to read them. When a new MF circular appears on the Learn page, check whether it changes a category, then edit this file.

**New AMFI labels.** If AMFI starts using a category label FundFit doesn't recognise (likely while AMCs finish moving to the 2026 names), the Action log lists it under "AMFI labels with no category match". Add that label to the matching category's `amfi` list in `data/categories.json`.

**Suggestion rules** are in `index.html` between `RULES-START` and `RULES-END`. Run `node --test tests/*.test.mjs` after any change; the tests check every answer combination against safety rules (no equity under 3 years, no ELSS for the new regime, and so on).

**Footer disclosure** is the `CONFIG` block at the top of the script in `index.html`. Add your AMFI registration line there only once you hold an ARN.

## Compliance choices built in

- The standard risk warning appears word for word in the footer.
- AMCs and schemes are listed A to Z, with no ranking, returns or "best" labels.
- No projected returns anywhere.
- Both plans are shown as facts ("Regular and Direct plans"), with a neutral explanation of the difference in Learn.
- Nothing is called advice; the result says it's a category suggestion, not a suitability review.

## Sources

- AMFI NAV file: https://www.amfiindia.com/spages/NAVAll.txt
- SEBI RSS: https://www.sebi.gov.in/sebirss.xml
- SEBI circular HO/24/13/15(2)2026-IMD-RAC4/I/5764/2026, 26 Feb 2026: Categorisation and Rationalisation of Mutual Fund Schemes
